import { mutationGeneric } from "convex/server";
import { v } from "convex/values";
import type { ProviderHelpers } from "../../lib/types";
import type { ComponentApi } from "./_generated/component.js";
import { generateRandomToken, sha256Base64Url } from "./crypto";
import { sha256Hex } from "../../lib/crypto";

/**
 * Provider-defined config for interacting with an individual OAuth provider.
 */
export type OauthCatalog = {
  /**
   * The provider's authorization endpoint (a full URL), e.g. Google's
   * `https://accounts.google.com/o/oauth2/v2/auth`.
   */
  authorizationEndpoint: string;
  /**
   * The provider's token endpoint (a full URL), e.g. Google's
   * `https://oauth2.googleapis.com/token`.
   */
  tokenEndpoint: string;
  /**
   * Expected `iss` (the OIDC issuer claim) of the provider's id_tokens, e.g.
   * Google's `https://accounts.google.com`. Present for OIDC providers;
   * absent for plain-OAuth providers (e.g., GitHub), where identity comes from
   * userinfo.
   */
  issuer?: string;
  /**
   * Endpoints (full URLs) the callback fetches with the access token (GET
   * with a bearer token), keyed by the name the profile mapping reads each
   * response under. Present for providers whose identity comes from
   * userinfo (GitHub).
   */
  userInfoEndpoints?: Record<string, string>;
  /** Scopes to request. */
  scopes: string[];
  /**
   * Send a PKCE `S256` challenge with the authorization request. Enable it for
   * providers that support PKCE alongside the client secret.
   */
  pkce: boolean;
};

/**
 * App-defined config for setting up an OAuth provider and passing in options.
 */
export type OauthProviderOptions = {
  /**
   * This provider's oauth component instance, e.g. `components.oauthGoogle`.
   * The component is installed once per provider.
   */
  component: ComponentApi;
  /**
   * Origins `redirectTo` may point at, e.g. `["https://app.example.com"]`
   * for open-redirect prevention.
   */
  allowedRedirectOrigins: string[];
};

/** `new URL` without the exception: returns null on unparseable input. */
function parseUrl(value: string): URL | null {
  try {
    return new URL(value);
  } catch {
    return null;
  }
}

/**
 * Set up OAuth sign-in against a single upstream identity provider.
 *
 * The flow:
 *
 * 1. `startSignIn` (here): validate, mint `state`, record an authorization
 *    request in the component, and return the provider authorization URL for
 *    the client to navigate to plus the state it must hold onto.
 * 2. The provider redirects back to the component's HTTP callback
 *    (`<site><httpPrefix>/callback`), which claims the request, exchanges
 *    the code, and mints a one-time ticket.
 *
 * The callback only accepts GET redirects. Providers that POST it
 * (`response_mode=form_post`, notably Apple when name/email scopes are
 * requested) are not supported yet.
 */
export function setupOauth(
  providerName: string,
  catalog: OauthCatalog,
  helpers: ProviderHelpers,
  options: OauthProviderOptions,
) {
  // Validate the app-supplied options up front so mistakes fail at deploy
  // time, not on the first sign-in.
  const allowedOrigins = options.allowedRedirectOrigins.map((allowed) => {
    const url = parseUrl(allowed);
    if (
      url === null ||
      (url.protocol !== "http:" && url.protocol !== "https:")
    ) {
      throw new Error(
        `allowedRedirectOrigins entry is not a valid http(s) origin: ` +
          `"${allowed}" (custom schemes like "myapp://" are not supported yet)`,
      );
    }
    return url.origin;
  });
  // Per OIDC, requesting the `openid` scope makes the provider return an
  // id_token, which must be validated against an expected issuer.
  if (catalog.scopes.includes("openid") && catalog.issuer === undefined) {
    throw new Error(
      `Provider "${providerName}" requests the "openid" scope, so the provider will return an id_token, but its catalog sets no issuer to validate it against`,
    );
  }

  /**
   * Start an OAuth sign-in. The server mints `state` and returns it;
   * the client keeps it (it must present the same value again to
   * complete sign-in) and navigates to the returned `redirect` URL.
   */
  const startSignIn = mutationGeneric({
    args: {
      redirectTo: v.string(),
    },
    returns: v.object({ redirect: v.string(), state: v.string() }),
    handler: async (ctx, args) => {
      const redirectTo = parseUrl(args.redirectTo);
      if (redirectTo === null) {
        throw new Error("redirectTo must be an absolute URL");
      }
      if (!allowedOrigins.includes(redirectTo.origin)) {
        throw new Error(
          `redirectTo origin "${redirectTo.origin}" is not in allowedRedirectOrigins`,
        );
      }

      const state = generateRandomToken();
      const codeVerifier = catalog.pkce ? generateRandomToken() : undefined;

      const stateHash = await sha256Hex(state);
      const { clientId, callbackUrl } = await ctx.runMutation(
        options.component.provider.createAuthorizationRequest,
        {
          providerName,
          stateHash,
          redirectTo: args.redirectTo,
          tokenEndpoint: catalog.tokenEndpoint,
          codeVerifier,
          userInfoEndpoints: catalog.userInfoEndpoints,
          issuer: catalog.issuer,
        },
      );

      const params: Record<string, string> = {
        response_type: "code",
        client_id: clientId,
        redirect_uri: callbackUrl,
        state,
      };

      if (catalog.scopes.length > 0) {
        params.scope = catalog.scopes.join(" ");
      }

      if (codeVerifier !== undefined) {
        params.code_challenge = await sha256Base64Url(codeVerifier);
        params.code_challenge_method = "S256";
      }

      const url = new URL(catalog.authorizationEndpoint);
      for (const [key, value] of Object.entries(params)) {
        url.searchParams.set(key, value);
      }

      return { redirect: url.toString(), state };
    },
  });

  return { startSignIn };
}
