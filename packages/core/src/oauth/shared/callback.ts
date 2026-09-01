/**
 * The provider callback, shared by every OAuth component.
 *
 * A component's `http.ts` is the transport adapter around this: it reads the
 * callback parameters out of whatever the provider sent (a GET query string,
 * a POST form body), supplies the endpoints and credentials to exchange the
 * code with, and hands the rest to {@link runCallback}.
 *
 * @module
 */
import {
  decodeJwtPayloadUnverified,
  encryptTicketPayload,
  generateRandomToken,
  type IssuerDeliveredJwt,
} from "../component/crypto.ts";
import { sha256Hex } from "../../lib/crypto.ts";
import { OAUTH_CODE_PARAM, OAUTH_ERROR_PARAM } from "../../lib/oauthParams.ts";
import type { OidcClaims, TicketPayload } from "./redemption.ts";

const FETCH_TIMEOUT_MS = 10 * 1000;

/**
 * The status a redirect back to the app uses. A provider that sends the
 * callback as a POST needs 303, which tells the browser to follow with a GET;
 * a provider that redirects there with a GET keeps 302.
 */
export type RedirectStatus = 302 | 303;

function redirect(location: string, status: RedirectStatus): Response {
  return new Response(null, {
    status,
    headers: { Location: location },
  });
}

/**
 * Redirect back to the app's `redirectTo` with outcome params. Stale outcome
 * params from a previous attempt are removed first, so a `redirectTo` derived
 * from the app's current URL can't carry a contradictory outcome.
 */
export function redirectToApp(
  redirectTo: string,
  params: Record<string, string>,
  status: RedirectStatus,
): Response {
  const url = new URL(redirectTo);
  url.searchParams.delete(OAUTH_CODE_PARAM);
  url.searchParams.delete(OAUTH_ERROR_PARAM);
  for (const [key, value] of Object.entries(params)) {
    url.searchParams.set(key, value);
  }
  return redirect(url.toString(), status);
}

/**
 * Turn the provider's `error` parameter into one of the codes the client
 * understands. `access_denied` is the standard code for a user who declined.
 * Everything unrecognized is a generic failure.
 */
export function normalizeProviderError(error: string | null): string {
  if (error === "access_denied") {
    return "access_denied";
  }
  return "oauth_error";
}

/**
 * Fetch that requires https, enforces a timeout, and treats any HTTP
 * redirect as an error. Token and userinfo endpoints never legitimately
 * redirect; following one could forward credentials to an unintended host,
 * and a non-https endpoint would expose them in transit.
 */
export async function fetchRefusingRedirects(
  url: string,
  init: RequestInit,
): Promise<{ ok: boolean; status: number; bodyText: string }> {
  if (new URL(url).protocol !== "https:") {
    throw new Error(`Refusing non-https request to ${url}`);
  }
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    const response = await fetch(url, {
      ...init,
      redirect: "manual",
      signal: controller.signal,
    });
    if (response.status >= 300 && response.status < 400) {
      throw new Error(`Request to ${url} responded with a redirect`);
    }
    return {
      ok: response.ok,
      status: response.status,
      bodyText: await response.text(),
    };
  } finally {
    clearTimeout(timeout);
  }
}

/**
 * Exchange an authorization code for tokens at the provider's token
 * endpoint. Credentials go in the POST body because HTTP Basic has a
 * form-urlencoding ambiguity many providers get wrong.
 */
export async function exchangeCode(args: {
  tokenEndpoint: string;
  code: string;
  callbackUrl: string;
  codeVerifier: string | undefined;
  clientId: string;
  clientSecret: string;
}): Promise<{
  idToken: IssuerDeliveredJwt | undefined;
  accessToken: string | undefined;
}> {
  const body = new URLSearchParams({
    grant_type: "authorization_code",
    code: args.code,
    client_id: args.clientId,
    client_secret: args.clientSecret,
    // Must byte-match the redirect_uri from the authorization request, so
    // it comes off the authorization request rather than being rebuilt here.
    redirect_uri: args.callbackUrl,
  });
  if (args.codeVerifier !== undefined) {
    body.set("code_verifier", args.codeVerifier);
  }
  const response = await fetchRefusingRedirects(args.tokenEndpoint, {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      // GitHub's token endpoint returns form-encoded output without this.
      Accept: "application/json",
    },
    body,
  });
  if (!response.ok) {
    throw new Error(
      `Token exchange failed with ${response.status}: ${response.bodyText}`,
    );
  }
  const tokens = JSON.parse(response.bodyText) as Record<string, unknown>;
  return {
    // Straight off the issuer's TLS response, which is what the brand attests.
    idToken:
      typeof tokens.id_token === "string"
        ? (tokens.id_token as IssuerDeliveredJwt)
        : undefined,
    accessToken:
      typeof tokens.access_token === "string" ? tokens.access_token : undefined,
  };
}

/**
 * Decode an id_token and check its claims:
 *
 * - `iss` must match one of the configured `issuers`, which are required
 *   whenever an id_token comes back: `sub` is only unique within an issuer,
 *   and a shared or multi-tenant token endpoint can serve several.
 * - `aud` must be exactly CLIENT_ID. Multi-audience tokens are rejected
 *   because no other audience is trusted.
 * - `azp`, when present, must be CLIENT_ID.
 * - `exp` must be in the future.
 *
 * Signature verification is deliberately skipped: the token came directly
 * from the provider's token endpoint over TLS, which OIDC Core sanctions in
 * place of checking the signature.
 */
export function validateIdToken(
  idToken: IssuerDeliveredJwt,
  expectedIssuers: string[] | undefined,
  clientId: string,
): Record<string, unknown> {
  if (expectedIssuers === undefined) {
    throw new Error(
      "The provider returned an id_token but no issuer is configured; set `issuer` in the provider options so the token can be validated",
    );
  }
  const claims = decodeJwtPayloadUnverified(idToken);
  if (typeof claims.iss !== "string" || !expectedIssuers.includes(claims.iss)) {
    throw new Error("id_token issuer does not match the configured issuer");
  }
  const audiences = Array.isArray(claims.aud) ? claims.aud : [claims.aud];
  if (audiences.length !== 1 || audiences[0] !== clientId) {
    throw new Error("id_token audience must be exactly CLIENT_ID");
  }
  if (claims.azp !== undefined && claims.azp !== clientId) {
    throw new Error("id_token authorized party does not match CLIENT_ID");
  }
  if (typeof claims.exp !== "number" || claims.exp * 1000 < Date.now()) {
    throw new Error("id_token is expired");
  }
  return claims;
}

/**
 * Fetch each configured userinfo endpoint with the access token.
 */
export async function fetchUserInfo(
  endpoints: Record<string, string>,
  accessToken: string,
): Promise<Record<string, unknown>> {
  const responses = await Promise.all(
    Object.entries(endpoints).map(async ([key, endpoint]) => {
      const response = await fetchRefusingRedirects(endpoint, {
        headers: {
          Authorization: `Bearer ${accessToken}`,
          Accept: "application/json",
          // GitHub's API rejects requests without a User-Agent.
          "User-Agent": "convex-auth",
        },
      });
      if (!response.ok) {
        throw new Error(
          `Userinfo request "${key}" failed with ${response.status}: ${response.bodyText}`,
        );
      }
      return [key, JSON.parse(response.bodyText) as unknown] as const;
    }),
  );
  return Object.fromEntries(responses);
}

/** The parameters a provider sends to the callback. */
export type CallbackRequestParams = {
  state: string | null;
  code: string | null;
  error: string | null;
  errorDescription: string | null;
};

/** What every component's claimed authorization request has in common. */
export type ClaimedRequest = {
  stateHash: string;
  redirectTo: string;
  callbackUrl: string;
};

/** What claiming an authorization request can produce. */
export type ClaimResult<Request extends ClaimedRequest> =
  null | { expired: true; redirectTo: string } | ({ expired: false } & Request);

/** Everything needed to exchange the code with one provider. */
export type ExchangeConfig = {
  /** The provider's name, for log messages. */
  providerName: string;
  /** The provider's token endpoint (a full URL). */
  tokenEndpoint: string;
  clientId: string;
  /**
   * The client secret to present at the token endpoint.
   *
   * It is a function so that a provider that has to build its secret (Apple
   * signs a fresh one per exchange) builds it inside the try block below,
   * where a failure redirects back to the app with `oauth_error`.
   */
  clientSecret: () => string | Promise<string>;
  /** PKCE verifier, for a provider the flow enabled PKCE for. */
  codeVerifier?: string;
  /** Accepted `iss` values, required when the provider returns an id_token. */
  issuers?: string[];
  /** Endpoints to fetch with the access token, keyed as the mapping reads them. */
  userInfoEndpoints?: Record<string, string>;
};

/**
 * Run the provider callback: claim the flow, exchange the code, and mint the
 * one-time ticket the app redeems, then redirect back to the app.
 *
 * Nothing user-visible (accounts, users, sessions) is created here. The
 * ticket is a short-lived, one-time proof that provider authentication
 * succeeded; only the hash of its code is stored, and the identity payload is
 * encrypted with a key derived from the raw code, so database access alone
 * can read neither.
 */
export async function runCallback<Request extends ClaimedRequest>(options: {
  /** Where the callback arrived, for log messages. */
  path: string;
  /** The callback parameters the transport adapter pulled out. */
  params: CallbackRequestParams;
  /** Claim the flow by state hash, in this component's own tables. */
  claim: (stateHash: string) => Promise<ClaimResult<Request>>;
  /** Store the minted ticket in this component's own tables. */
  mintTicket: (
    request: Request,
    ticket: { ticketCodeHash: string; encryptedPayload: string },
  ) => Promise<null>;
  /** The endpoints and credentials for this flow's provider. */
  exchangeConfig: (request: Request) => ExchangeConfig;
  /** The status used by redirects back to the app. */
  redirectStatus: RedirectStatus;
}): Promise<Response> {
  const { params, redirectStatus } = options;

  // Without state we can't identify the flow, so there's no stored
  // redirectTo to send the user back to; a bare 400 is all we have.
  if (params.state === null) {
    return new Response(
      "This sign-in link is invalid. Return to the app and try signing in again.",
      { status: 400 },
    );
  }

  // Claiming is atomic (find + delete in one mutation), so a replayed or
  // raced callback finds nothing. Possession of the provider-echoed state
  // is the only check here; binding to the initiating client happens at
  // redemption.
  const authRequest = await options.claim(await sha256Hex(params.state));
  // Nothing found means the flow is gone entirely (already claimed, or
  // forged); there is nowhere left to redirect to.
  if (authRequest === null) {
    console.warn(
      `OAuth callback at "${options.path}": unknown or already-used state`,
    );
    return new Response(
      "This sign-in link has expired or was already used. Return to the app and try signing in again.",
      { status: 400 },
    );
  }
  // An expired request still knows where the user came from; send them
  // back to the app instead of stranding them here.
  if (authRequest.expired) {
    console.warn(
      `OAuth callback at "${options.path}": expired authorization request`,
    );
    return redirectToApp(
      authRequest.redirectTo,
      { [OAUTH_ERROR_PARAM]: "expired" },
      redirectStatus,
    );
  }

  const config = options.exchangeConfig(authRequest);

  // From here on the flow is legitimate, so failures go back to the app
  // as a normalized error param; raw detail goes to logs only.
  if (params.error !== null || params.code === null) {
    console.error(
      `OAuth callback error from provider "${config.providerName}":`,
      params.error ?? "missing code",
      params.errorDescription ?? "",
    );
    return redirectToApp(
      authRequest.redirectTo,
      { [OAUTH_ERROR_PARAM]: normalizeProviderError(params.error) },
      redirectStatus,
    );
  }

  try {
    const { idToken, accessToken } = await exchangeCode({
      tokenEndpoint: config.tokenEndpoint,
      code: params.code,
      callbackUrl: authRequest.callbackUrl,
      codeVerifier: config.codeVerifier,
      clientId: config.clientId,
      clientSecret: await config.clientSecret(),
    });

    const claims =
      idToken === undefined
        ? undefined
        : (validateIdToken(
            idToken,
            config.issuers,
            config.clientId,
          ) as OidcClaims);

    if (config.userInfoEndpoints !== undefined && accessToken === undefined) {
      throw new Error("Token exchange returned no access_token");
    }
    const userInfoResponses =
      config.userInfoEndpoints === undefined || accessToken === undefined
        ? undefined
        : await fetchUserInfo(config.userInfoEndpoints, accessToken);

    // A provider that returns no id_token and has no configured userinfo
    // endpoints gives us nothing to identify the user with.
    if (claims === undefined && userInfoResponses === undefined) {
      throw new Error(
        "Token exchange returned no id_token and no userInfoEndpoints are configured",
      );
    }

    const ticketCode = generateRandomToken();
    await options.mintTicket(authRequest, {
      ticketCodeHash: await sha256Hex(ticketCode),
      encryptedPayload: await encryptTicketPayload(
        ticketCode,
        JSON.stringify({ claims, userInfoResponses } satisfies TicketPayload),
      ),
    });

    return redirectToApp(
      authRequest.redirectTo,
      { [OAUTH_CODE_PARAM]: ticketCode },
      redirectStatus,
    );
  } catch (exchangeError) {
    console.error(
      `OAuth exchange failed for provider "${config.providerName}":`,
      exchangeError,
    );
    return redirectToApp(
      authRequest.redirectTo,
      { [OAUTH_ERROR_PARAM]: "oauth_error" },
      redirectStatus,
    );
  }
}
