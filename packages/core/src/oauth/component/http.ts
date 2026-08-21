import { GenericActionCtx, GenericDataModel, httpRouter } from "convex/server";
import { env, httpAction } from "./_generated/server.js";
import { internal } from "./_generated/api.js";
import { CALLBACK_PATH } from "./constants.js";
import {
  decodeJwtPayloadUnverified,
  encryptTicketPayload,
  generateRandomToken,
  type IssuerDeliveredJwt,
} from "./crypto.js";
import { sha256Hex } from "../../lib/crypto.js";
import { OAUTH_CODE_PARAM, OAUTH_ERROR_PARAM } from "../../lib/oauthParams.js";

const http = httpRouter();

const FETCH_TIMEOUT_MS = 10 * 1000;

function redirect(location: string): Response {
  return new Response(null, {
    status: 302,
    headers: { Location: location },
  });
}

/**
 * 302 back to the app's `redirectTo` with outcome params. Stale outcome params
 * from a previous attempt are removed first, so a `redirectTo` derived from the
 * app's current URL can't carry a contradictory outcome.
 */
function redirectToApp(
  redirectTo: string,
  params: Record<string, string>,
): Response {
  const url = new URL(redirectTo);
  url.searchParams.delete(OAUTH_CODE_PARAM);
  url.searchParams.delete(OAUTH_ERROR_PARAM);
  for (const [key, value] of Object.entries(params)) {
    url.searchParams.set(key, value);
  }
  return redirect(url.toString());
}

/**
 * Fetch that requires https, enforces a timeout, and treats any HTTP
 * redirect as an error. Token and userinfo endpoints never legitimately
 * redirect; following one could forward credentials to an unintended host,
 * and a non-https endpoint would expose them in transit.
 */
async function fetchRefusingRedirects(
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
async function exchangeCode(args: {
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
    // it comes off the request row rather than being rebuilt here.
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
function validateIdToken(
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
async function fetchUserInfo(
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

/**
 * Handle the provider callback.
 */
async function handleCallback(
  ctx: GenericActionCtx<GenericDataModel>,
  request: Request,
): Promise<Response> {
  const url = new URL(request.url);
  const state = url.searchParams.get("state");
  const code = url.searchParams.get("code");
  const error = url.searchParams.get("error");

  // Without state we can't identify the flow, so there's no stored
  // redirectTo to send the user back to; a bare 400 is all we have.
  if (state === null) {
    return new Response(
      "This sign-in link is invalid. Return to the app and try signing in again.",
      { status: 400 },
    );
  }

  // Claiming is atomic (find + delete in one mutation), so a replayed or
  // raced callback finds nothing. Possession of the provider-echoed state
  // is the only check here; binding to the initiating client happens at
  // redemption.
  const authRequest = await ctx.runMutation(
    internal.provider.claimAuthorizationRequest,
    { stateHash: await sha256Hex(state) },
  );
  // No row means the flow is gone entirely (already claimed, or forged);
  // there is nowhere left to redirect to.
  if (authRequest === null) {
    console.warn(
      `OAuth callback at "${url.pathname}": unknown or already-used state`,
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
      `OAuth callback at "${url.pathname}": expired authorization request`,
    );
    return redirectToApp(authRequest.redirectTo, {
      [OAUTH_ERROR_PARAM]: "expired",
    });
  }

  // From here on the flow is legitimate, so failures go back to the app
  // as a normalized error param; raw detail goes to logs only.
  if (error !== null || code === null) {
    console.error(
      `OAuth callback error from provider "${authRequest.providerName}":`,
      error ?? "missing code",
      url.searchParams.get("error_description") ?? "",
    );
    const normalized =
      error === "access_denied" ? "access_denied" : "oauth_error";
    return redirectToApp(authRequest.redirectTo, {
      [OAUTH_ERROR_PARAM]: normalized,
    });
  }

  try {
    const { idToken, accessToken } = await exchangeCode({
      tokenEndpoint: authRequest.tokenEndpoint,
      code,
      callbackUrl: authRequest.callbackUrl,
      codeVerifier: authRequest.codeVerifier,
      clientId: env.CLIENT_ID,
      clientSecret: env.CLIENT_SECRET,
    });

    const claims =
      idToken === undefined
        ? undefined
        : validateIdToken(idToken, authRequest.issuers, env.CLIENT_ID);

    if (
      authRequest.userInfoEndpoints !== undefined &&
      accessToken === undefined
    ) {
      throw new Error("Token exchange returned no access_token");
    }
    const userInfoResponses =
      authRequest.userInfoEndpoints === undefined || accessToken === undefined
        ? undefined
        : await fetchUserInfo(authRequest.userInfoEndpoints, accessToken);

    // A provider that returns no id_token and has no configured userinfo
    // endpoints gives us nothing to identify the user with.
    if (claims === undefined && userInfoResponses === undefined) {
      throw new Error(
        "Token exchange returned no id_token and no userInfoEndpoints are configured",
      );
    }

    // Nothing user-visible exists yet; the ticket is a short-lived,
    // one-time proof that provider authentication succeeded. Only the
    // hash of the ticket code is stored, and the identity payload is
    // encrypted with a key derived from the raw code, so database access
    // alone can read neither.
    const ticketCode = generateRandomToken();
    await ctx.runMutation(internal.provider.createTicket, {
      providerName: authRequest.providerName,
      stateHash: authRequest.stateHash,
      ticketCodeHash: await sha256Hex(ticketCode),
      encryptedPayload: await encryptTicketPayload(
        ticketCode,
        JSON.stringify({ claims, userInfoResponses }),
      ),
    });

    return redirectToApp(authRequest.redirectTo, {
      [OAUTH_CODE_PARAM]: ticketCode,
    });
  } catch (exchangeError) {
    console.error(
      `OAuth exchange failed for provider "${authRequest.providerName}":`,
      exchangeError,
    );
    return redirectToApp(authRequest.redirectTo, {
      [OAUTH_ERROR_PARAM]: "oauth_error",
    });
  }
}

http.route({
  path: CALLBACK_PATH,
  method: "GET",
  handler: httpAction(handleCallback),
});

export default http;
