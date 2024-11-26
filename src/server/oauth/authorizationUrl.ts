// This file corresponds to packages/core/src/lib/actions/signin/authorization-url.ts in the @auth/core package (commit 5af1f30a32e64591abc50ae4d2dba4682e525431).
import * as checks from "./checks.js";
import { InternalOptions } from "./types.js";
import {
  callbackUrl,
  getAuthorizationSignature,
} from "./convexAuth.js";
import { Cookie } from "@auth/core/lib/utils/cookie.js";
import { logWithLevel } from "../implementation/utils.js";

/**
 * Generates an authorization/request token URL.
 *
 * [OAuth 2](https://www.oauth.com/oauth2-servers/authorization/the-authorization-request/)
 */
export async function getAuthorizationUrl(
  // ConvexAuth: we don't accept a query argument
  options: InternalOptions<"oauth" | "oidc">,
) {
  const { provider } = options;

  let url = provider.authorization?.url;

  // ConvexAuth: ConvexAuth does slightly different logic to determine the authorization endpoint
  const { as, authorization: authorizationEndpoint, configSource } = provider;

  if (!authorizationEndpoint) {
    throw new TypeError("Could not determine the authorization endpoint.");
  }
  if (!url) {
    url = new URL(authorizationEndpoint.url);
  }

  const authParams = url.searchParams;

  // ConvexAuth: The logic for the callback URL is different from Auth.js
  const redirect_uri = callbackUrl(provider.id);
  // TODO(ConvexAuth): Support redirect proxy URLs.
  // If we do so, update state.create to take the data value as an origin parameter (see the Auth.js code for ref).
  // let data: string | undefined;
  // if (!options.isOnRedirectProxy && provider.redirectProxyUrl) {
  //   redirect_uri = provider.redirectProxyUrl;
  //   data = provider.callbackUrl;
  //   logger.debug("using redirect proxy", { redirect_uri, data });
  // }

  const params = Object.assign(
    {
      response_type: "code",
      // clientId can technically be undefined, should we check this in assert.ts or rely on the Authorization Server to do it?
      client_id: provider.clientId,
      redirect_uri,
      // @ts-expect-error TODO:
      ...provider.authorization?.params,
    },
    Object.fromEntries(url.searchParams.entries() ?? []),
    // ConvexAuth: no query arguments are combined in the params
  );

  for (const k in params) authParams.set(k, params[k]);

  const cookies: Cookie[] = [];

  // ConvexAuth: no value passed for `origin` (Auth.js uses `data` from above)
  const state = await checks.state.create(options);
  if (state) {
    authParams.set("state", state.value);
    cookies.push(state.cookie);
  }

  // ConvexAuth: We need to save the value of the codeVerifier.
  let codeVerifier: string | undefined;
  if (provider.checks?.includes("pkce")) {
    // ConvexAuth: we check where the config came from to help decide which branch to take here
    if (configSource === "discovered" && !as.code_challenge_methods_supported?.includes("S256")) {
      // We assume S256 PKCE support, if the server does not advertise that,
      // a random `nonce` must be used for CSRF protection.
      if (provider.type === "oidc") provider.checks = ["nonce"];
    } else {
      const pkce = await checks.pkce.create(options);
      authParams.set("code_challenge", pkce.codeChallenge);
      authParams.set("code_challenge_method", "S256");
      cookies.push(pkce.cookie);
      codeVerifier = pkce.codeVerifier;
    }
  }

  const nonce = await checks.nonce.create(options);
  if (nonce) {
    authParams.set("nonce", nonce.value);
    cookies.push(nonce.cookie);
  }

  // TODO: This does not work in normalizeOAuth because authorization endpoint can come from discovery
  // Need to make normalizeOAuth async
  if (provider.type === "oidc" && !url.searchParams.has("scope")) {
    url.searchParams.set("scope", "openid profile email");
  }

  logWithLevel("DEBUG", "authorization url is ready", {
    url,
    cookies,
    provider,
  });

  const convexAuthSignature = getAuthorizationSignature({
    codeVerifier,
    state: authParams.get("state") ?? undefined,
    nonce: authParams.get("nonce") ?? undefined,
  });

  return { redirect: url.toString(), cookies, signature: convexAuthSignature };
}
