import { mutationGeneric } from "convex/server";
import { v } from "convex/values";
import { defineProvider } from "../../lib/types";
import type { ComponentApi } from "./_generated/component.js";
import { generateRandomToken, sha256Base64Url } from "./crypto";
import { sha256Hex } from "../../lib/crypto";
import { capitalize } from "../../lib/strings";

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
  /** Default scopes to request; overridable via {@link OauthProviderOptions.scopes}. */
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
   * This provider's oauth component mount, e.g. `components.oauthGoogle`.
   * The component is mounted once per provider.
   */
  component: ComponentApi;
  /**
   * Origins `redirectTo` may point at, e.g. `["https://app.example.com"]`
   * for open-redirect prevention.
   */
  allowedRedirectOrigins: string[];
  /**
   * Override the provider's default scopes (e.g. to request extra scopes).
   */
  scopes?: string[];
  /**
   * Extra query params for the authorization URL, e.g. Google's
   * `{ access_type: "offline" }`. Must not include protocol params (listed below).
   */
  extraAuthorizationParams?: Record<string, string>;
};

/** `new URL` without the exception: returns null on unparseable input. */
function parseUrl(value: string): URL | null {
  try {
    return new URL(value);
  } catch {
    return null;
  }
}

/** Params `startSignIn` sets itself, these are not allowed in `extraAuthorizationParams`. */
const PROTOCOL_PARAMS = [
  "response_type",
  "client_id",
  "redirect_uri",
  "state",
  "scope",
  "code_challenge",
  "code_challenge_method",
];

/**
 * OAuth sign-in against a single upstream identity provider. Each supported
 * provider ships an instance built with its catalog; the app registers
 * those:
 *
 * ```ts
 * providers: [
 *   provider(OauthGoogle, {
 *     component: components.oauthGoogle,
 *     allowedRedirectOrigins: [...],
 *   }),
 * ]
 * ```
 *
 * This is the first leg of the flow: `startSignIn` validates, mints `state`,
 * records an authorization request in the component, and returns the provider
 * authorization URL for the client to navigate to plus the state it must hold
 * onto. The provider later redirects back to the mount's HTTP callback
 * (`<site><httpPrefix>/callback`), which claims the request by state hash.
 *
 * The function is returned with the provider name embedded in the key
 * (`startSignInGoogle` for `Oauth("google", ...)`), so multiple providers can
 * be re-exported side by side without renaming.
 *
 * The component is mounted once per provider in `convex.config.ts`, binding
 * that provider's `PROVIDER_NAME`, `CLIENT_ID`, and `CLIENT_SECRET`; register
 * `<site-url><httpPrefix>/callback` as the redirect URI with the identity
 * provider. The mount's `httpPrefix` alone determines the callback URL — the
 * component derives it from its mount-prefixed `CONVEX_SITE_URL`, so there's
 * nothing to repeat in the provider options.
 */
export function Oauth<const N extends string>(
  providerName: N,
  catalog: OauthCatalog,
) {
  return defineProvider({
    name: providerName,
    setup: (helpers, options: OauthProviderOptions) => {
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
      const scopes = options.scopes ?? catalog.scopes;
      // Per OIDC, requesting the `openid` scope makes the provider return an
      // id_token, which must be validated against an expected issuer. Catalogs
      // pair the two, but a scopes override can add `openid` to a catalog with
      // no issuer.
      if (scopes.includes("openid") && catalog.issuer === undefined) {
        throw new Error(
          `Provider "${providerName}" requests the "openid" scope, so the provider will return an id_token, but its catalog sets no issuer to validate it against`,
        );
      }
      for (const key of Object.keys(options.extraAuthorizationParams ?? {})) {
        if (PROTOCOL_PARAMS.includes(key)) {
          throw new Error(
            `extraAuthorizationParams for provider "${providerName}" must not set protocol param "${key}"`,
          );
        }
      }

      const suffix = capitalize(providerName);

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

          // Only the hash crosses the component boundary, so the raw state is
          // neither stored nor visible in function logs. Exchange config the
          // callback needs is stored on the request row; the provider's
          // CLIENT_ID and the mount-derived redirect_uri are returned to form
          // the authorization URL.
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
            ...options.extraAuthorizationParams,
            response_type: "code",
            client_id: clientId,
            redirect_uri: callbackUrl,
            state,
          };

          if (scopes.length > 0) {
            params.scope = scopes.join(" ");
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

      // Bake the provider name into the key (`startSignInGoogle`, …) so the
      // app can re-export multiple providers side by side without renaming.
      return {
        [`startSignIn${suffix}`]: startSignIn,
      } as {
        [K in `startSignIn${Capitalize<N>}`]: typeof startSignIn;
      };
    },
  });
}
