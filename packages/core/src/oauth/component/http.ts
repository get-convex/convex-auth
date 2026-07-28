import { GenericActionCtx, GenericDataModel, httpRouter } from "convex/server";
import { httpAction } from "./_generated/server";
import { internal } from "./_generated/api";
import { CALLBACK_PATH } from "./constants";
import { getCredentials, SUPPORTED_PROVIDERS } from "./credentials";
import {
  decodeJwtPayloadUnverified,
  encryptWithToken,
  generateRandomToken,
} from "./crypto";
import { sha256Hex } from "../../lib/crypto";
import { OAUTH_CODE_PARAM, OAUTH_ERROR_PARAM } from "../../lib/oauthParams";

// The component is mounted once (`app.use(oauth, { httpPrefix: "/oauth", ... })`)
// and serves one callback per supported provider under
// <prefix>/<provider>/callback — the redirect URI registered with that identity provider.
const http = httpRouter();

/** Outbound requests fail after this instead of pinning the callback to the platform limit. */
const FETCH_TIMEOUT_MS = 30 * 1000;

/** A 302 redirect response. */
function redirect(location: string): Response {
  return new Response(null, {
    status: 302,
    headers: { Location: location },
  });
}

/**
 * 302 back to the app's `redirectTo` with outcome params. Stale outcome params
 * from a previous attempt are removed first, so a `redirectTo` derived from the
 * app's current URL can't carry a contradictory outcome. The params are
 * namespaced ({@link OAUTH_CODE_PARAM}/{@link OAUTH_ERROR_PARAM}) so the app's
 * always-on client callback handler can tell this redirect apart from an
 * unrelated `?code=`/`?error=` the app uses for its own purposes.
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
 * Fetch that enforces a timeout and treats any HTTP redirect as an error.
 * Token and userinfo endpoints never legitimately redirect; following one
 * could forward credentials to an unintended host. The body is consumed
 * while the timeout is still armed, so an endpoint that stalls before or
 * after sending headers becomes a normal failure that redirects the user
 * back to the app instead of pinning the callback until the platform limit.
 */
async function fetchRefusingRedirects(
  url: string,
  init: RequestInit,
): Promise<{ ok: boolean; status: number; bodyText: string }> {
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
 * endpoint. Client credentials are sent in the POST body — empirically the
 * most compatible style (HTTP Basic has a form-urlencoding ambiguity many
 * providers get wrong).
 */
async function exchangeCode(args: {
  tokenEndpoint: string;
  code: string;
  callbackUrl: string;
  codeVerifier: string | undefined;
  clientId: string;
  clientSecret: string;
}): Promise<{ idToken: string | undefined; accessToken: string | undefined }> {
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
    idToken: typeof tokens.id_token === "string" ? tokens.id_token : undefined,
    accessToken:
      typeof tokens.access_token === "string" ? tokens.access_token : undefined,
  };
}

/**
 * Decode an id_token and check its claims:
 *
 * - `iss` must match the configured `issuer`, which is required whenever an
 *   id_token comes back: `sub` is only unique within an issuer, and a shared
 *   or multi-tenant token endpoint can serve several.
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
  idToken: string,
  expectedIssuer: string | undefined,
  clientId: string,
): Record<string, unknown> {
  if (expectedIssuer === undefined) {
    throw new Error(
      "The provider returned an id_token but no issuer is configured; set `issuer` in the provider options so the token can be validated",
    );
  }
  const claims = decodeJwtPayloadUnverified(idToken);
  if (claims.iss !== expectedIssuer) {
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
 * Fetch each configured userinfo endpoint with the access token. All
 * popular providers accept the same shape — GET with a bearer token — with
 * provider variation living in the endpoint URL's query params.
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
 * Handle a provider callback. `pathProvider` is the provider whose route served
 * this request (`/google/callback` → `"google"`); it must match the provider
 * the claimed authorization request was issued for, or the flow is treated as a
 * mix-up and sent back to the app as a normalized error.
 */
async function handleCallback(
  ctx: GenericActionCtx<GenericDataModel>,
  request: Request,
  pathProvider: string,
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
    return new Response(
      "This sign-in link has expired or was already used. Return to the app and try signing in again.",
      { status: 400 },
    );
  }
  // An expired request still knows where the user came from; send them
  // back to the app instead of stranding them here.
  if (authRequest.expired) {
    return redirectToApp(authRequest.redirectTo, {
      [OAUTH_ERROR_PARAM]: "expired",
    });
  }

  // The route that served this callback must match the provider the request
  // was issued for. A mismatch means the redirect URI registered with an identity provider
  // points at the wrong provider's route (or a forged flow); don't run the
  // exchange under the wrong credentials.
  if (authRequest.providerName !== pathProvider) {
    console.error(
      `OAuth callback provider mismatch: "${pathProvider}" route served a "${authRequest.providerName}" request`,
    );
    return redirectToApp(authRequest.redirectTo, {
      [OAUTH_ERROR_PARAM]: "oauth_error",
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
    const { clientId, clientSecret } = getCredentials(authRequest.providerName);
    const { idToken, accessToken } = await exchangeCode({
      tokenEndpoint: authRequest.tokenEndpoint,
      code,
      callbackUrl: authRequest.callbackUrl,
      codeVerifier: authRequest.codeVerifier,
      clientId,
      clientSecret,
    });

    const claims =
      idToken === undefined
        ? undefined
        : validateIdToken(idToken, authRequest.issuer, clientId);

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
    // hash of the one-time token is stored, and the identity payload is
    // encrypted with a key derived from the raw token, so database access
    // alone can read neither.
    const ott = generateRandomToken();
    await ctx.runMutation(internal.provider.createTicket, {
      providerName: authRequest.providerName,
      stateHash: authRequest.stateHash,
      ottHash: await sha256Hex(ott),
      payload: await encryptWithToken(
        ott,
        JSON.stringify({ claims, userInfoResponses }),
      ),
    });

    return redirectToApp(authRequest.redirectTo, { [OAUTH_CODE_PARAM]: ott });
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

// One callback route per supported provider, under <mount prefix>/<provider>.
// The provider name is captured from the route so the handler can match it
// against the claimed request and select that provider's credentials.
for (const provider of SUPPORTED_PROVIDERS) {
  http.route({
    path: `/${provider}${CALLBACK_PATH}`,
    method: "GET",
    handler: httpAction((ctx, request) =>
      handleCallback(ctx, request, provider),
    ),
  });
}

export default http;
