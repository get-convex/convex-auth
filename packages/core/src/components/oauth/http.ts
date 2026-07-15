import { httpRouter } from "convex/server";
import { env, httpAction } from "./_generated/server";
import { internal } from "./_generated/api";
import { decodeJwtPayload, generateRandomToken, sha256Hex } from "./crypto";

// Each per-IdP mount serves its own provider callback under the prefix the
// app declares in convex.config.ts (`app.use(oauthProvider, { name:
// "oauthGoogle", httpPrefix: "/oauth/google", ... })`), so the served path
// is <prefix>/callback — the redirect URI registered with the provider.
const http = httpRouter();

/** Append query params to an absolute URL, preserving existing ones. */
function withParams(target: string, params: Record<string, string>): string {
  const url = new URL(target);
  for (const [key, value] of Object.entries(params)) {
    url.searchParams.set(key, value);
  }
  return url.toString();
}

/** A 302 redirect response. */
function redirect(location: string): Response {
  return new Response(null, {
    status: 302,
    headers: { Location: location },
  });
}

/**
 * Fetch that treats any HTTP redirect as an error. Token and userinfo
 * endpoints never legitimately redirect; following one could forward
 * credentials to an unintended host.
 */
async function fetchRefusingRedirects(
  url: string,
  init: RequestInit,
): Promise<Response> {
  const response = await fetch(url, { ...init, redirect: "manual" });
  if (response.status >= 300 && response.status < 400) {
    throw new Error(`Request to ${url} responded with a redirect`);
  }
  return response;
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
  codeVerifier: string | undefined;
}): Promise<{ idToken: string | undefined; accessToken: string | undefined }> {
  const body = new URLSearchParams({
    grant_type: "authorization_code",
    code: args.code,
    client_id: env.CLIENT_ID,
    client_secret: env.CLIENT_SECRET,
    redirect_uri: `${process.env.CONVEX_SITE_URL}/callback`,
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
      `Token exchange failed with ${response.status}: ${await response.text()}`,
    );
  }
  const tokens = await response.json();
  return {
    idToken: typeof tokens.id_token === "string" ? tokens.id_token : undefined,
    accessToken:
      typeof tokens.access_token === "string" ? tokens.access_token : undefined,
  };
}

/**
 * Decode an id_token and check the claims that guard against config mixups:
 * the token was minted for this OAuth app (`aud`) and isn't expired (`exp`).
 * Signature verification is deliberately skipped — the token came directly
 * from the provider's token endpoint over TLS, which OIDC Core sanctions in
 * place of checking the signature.
 */
function validateIdToken(idToken: string): Record<string, unknown> {
  const claims = decodeJwtPayload(idToken);
  const audiences = Array.isArray(claims.aud) ? claims.aud : [claims.aud];
  if (!audiences.includes(env.CLIENT_ID)) {
    throw new Error("id_token audience does not match CLIENT_ID");
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
          `Userinfo request "${key}" failed with ${response.status}: ${await response.text()}`,
        );
      }
      return [key, await response.json()] as const;
    }),
  );
  return Object.fromEntries(responses);
}

http.route({
  path: "/callback",
  method: "GET",
  handler: httpAction(async (ctx, request) => {
    const url = new URL(request.url);
    const state = url.searchParams.get("state");
    const code = url.searchParams.get("code");
    const error = url.searchParams.get("error");

    // Without state we can't identify the flow, so there's no stored
    // redirectTo to send the user back to — a bare 400 is all we have.
    if (state === null) {
      return new Response("Missing state", { status: 400 });
    }

    // Claiming is atomic (find + delete in one mutation), so a replayed or
    // raced callback finds nothing. Possession of the provider-echoed state
    // is the only check here; binding to the initiating client happens at
    // redemption.
    const authRequest = await ctx.runMutation(
      internal.provider.claimAuthorizationRequest,
      { stateHash: await sha256Hex(state) },
    );
    if (authRequest === null) {
      return new Response("Unknown or expired authorization request", {
        status: 400,
      });
    }

    // From here on the flow is legitimate, so failures go back to the app
    // as a normalized error param; raw detail goes to logs only.
    if (error !== null || code === null) {
      console.error(
        `OAuth callback error from provider "${authRequest.provider}":`,
        error ?? "missing code",
        url.searchParams.get("error_description") ?? "",
      );
      const normalized = error === "access_denied" ? "access_denied" : "oauth_error";
      return redirect(withParams(authRequest.redirectTo, { error: normalized }));
    }

    try {
      const { idToken, accessToken } = await exchangeCode({
        tokenEndpoint: authRequest.tokenEndpoint,
        code,
        codeVerifier: authRequest.codeVerifier,
      });

      const claims = idToken === undefined ? undefined : validateIdToken(idToken);

      let userInfoResponses: Record<string, unknown> | undefined;
      if (authRequest.userinfoEndpoints !== undefined) {
        if (accessToken === undefined) {
          throw new Error("Token exchange returned no access_token");
        }
        userInfoResponses = await fetchUserInfo(
          authRequest.userinfoEndpoints,
          accessToken,
        );
      }

      // A provider that returns no id_token and has no configured userinfo
      // endpoints gives us nothing to identify the user with.
      if (claims === undefined && userInfoResponses === undefined) {
        throw new Error(
          "Token exchange returned no id_token and no userinfoEndpoints are configured",
        );
      }

      // Nothing user-visible exists yet; the ticket is a short-lived,
      // one-time proof that provider authentication succeeded. Only the
      // hash of the one-time token is stored.
      const ott = generateRandomToken();
      await ctx.runMutation(internal.provider.createTicket, {
        provider: authRequest.provider,
        stateHash: authRequest.stateHash,
        ottHash: await sha256Hex(ott),
        claims,
        userInfoResponses,
      });

      return redirect(withParams(authRequest.redirectTo, { code: ott }));
    } catch (exchangeError) {
      console.error(
        `OAuth exchange failed for provider "${authRequest.provider}":`,
        exchangeError,
      );
      return redirect(withParams(authRequest.redirectTo, { error: "oauth_error" }));
    }
  }),
});

export default http;
