// This file corresponds to packages/core/src/lib/actions/signin/authorization-url.ts in the @auth/core package (commit 5af1f30a32e64591abc50ae4d2dba4682e525431).
import * as checks from "./checks.js";
import * as o from "oauth4webapi";
import { InternalOptions } from "./types.js";
import { fetchOpt } from "./lib/utils/customFetch.js";
import { callbackUrl } from "./convexAuth.js";
import { Cookie } from "@auth/core/lib/utils/cookie.js";
import { logWithLevel } from "../implementation/utils.js";

/**
 * Generates an authorization/request token URL.
 *
 * [OAuth 2](https://www.oauth.com/oauth2-servers/authorization/the-authorization-request/)
 */
export async function getAuthorizationUrl(
  // ConvexAuth: `params` is a Record<string, string> instead of RequestInternal["query"]
  query: Record<string, string>,
  options: InternalOptions<"oauth" | "oidc">,
) {
  const { provider } = options;

  let url = provider.authorization?.url;

  // ConvexAuth: Logic for a fallback to authjs.dev is omitted
  if (provider.issuer === undefined) {
    throw new Error(
      `Provider \`${provider.id}\` is missing an \`issuer\` URL configuration. Consult the provider docs.`,
    );
  }

  const issuer = new URL(provider.issuer);
  // TODO: move away from allowing insecure HTTP requests
  const discoveryResponse = await o.discoveryRequest(issuer, {
    ...fetchOpt(options.provider),
    [o.allowInsecureRequests]: true,
  });
  const as = await o.processDiscoveryResponse(issuer, discoveryResponse);

  if (!as.authorization_endpoint) {
    throw new TypeError(
      "Authorization server did not provide an authorization endpoint.",
    );
  }

  url = new URL(as.authorization_endpoint);

  const authParams = url.searchParams;

  // ConvexAuth: The logic for the callback URL is different from Auth.js
  const redirect_uri = callbackUrl(provider.id);
  // TODO(ConvexAuth): Support redirect proxy URLs
  let data: string | undefined;
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
      ...provider.authorization?.params,
    },
    Object.fromEntries(provider.authorization?.url.searchParams ?? []),
    query,
  );

  for (const k in params) authParams.set(k, params[k]);

  const cookies: Cookie[] = [];

  const state = await checks.state.create(options, data);
  if (state) {
    authParams.set("state", state.value);
    cookies.push(state.cookie);
  }

  if (provider.checks?.includes("pkce")) {
    if (as && !as.code_challenge_methods_supported?.includes("S256")) {
      // We assume S256 PKCE support, if the server does not advertise that,
      // a random `nonce` must be used for CSRF protection.
      if (provider.type === "oidc") provider.checks = ["nonce"];
    } else {
      const { value, cookie } = await checks.pkce.create(options);
      authParams.set("code_challenge", value);
      authParams.set("code_challenge_method", "S256");
      cookies.push(cookie);
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
  return { redirect: url.toString(), cookies };
}
