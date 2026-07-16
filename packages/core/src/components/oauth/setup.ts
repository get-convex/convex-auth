import { mutationGeneric } from "convex/server";
import { v } from "convex/values";
import {
  defineProvider,
  vTokenBundle,
  type TokenBundle,
} from "../../lib/types";
import type { ComponentApi } from "./_generated/component.js";
import { generateRandomToken, sha256Base64Url, sha256Hex } from "./crypto";

/**
 * Standard OIDC id_token claims, loosely typed: the well-known ones are
 * named, everything else comes through the index signature.
 */
export type OidcClaims = {
  sub: string;
  email?: string;
  email_verified?: boolean;
  name?: string;
  picture?: string;
  [claim: string]: unknown;
};

/**
 * Options for one {@link Oauth} provider instance (a single IdP).
 */
export type OauthOptions = {
  /**
   * This IdP's component mount (e.g. `components.oauthGoogle`). The
   * component is mounted once per IdP so each mount can bind its own
   * `CLIENT_ID`/`CLIENT_SECRET` and serve its own callback route.
   */
  component: ComponentApi;
  /** The provider's authorization endpoint, e.g. Google's `https://accounts.google.com/o/oauth2/v2/auth`. */
  authorizationEndpoint: string;
  /** The provider's token endpoint, e.g. Google's `https://oauth2.googleapis.com/token`. */
  tokenEndpoint: string;
  /**
   * Expected `iss` of the provider's id_tokens, e.g. Google's
   * `https://accounts.google.com`. Recommended for every OIDC provider:
   * `sub` is only unique within an issuer, so a token endpoint that serves
   * multiple issuers (multi-tenant IdPs) could otherwise collide account
   * identities. When set, the callback rejects id_tokens from any other
   * issuer.
   */
  issuer?: string;
  /**
   * Profile endpoints the callback fetches with the access token after the
   * code exchange (GET with a bearer token; provider variation lives in the
   * URL's query params). Keys name each response in the `profile` mapping's
   * second argument. Required for providers that don't return an OIDC
   * id_token, e.g. GitHub:
   *
   * ```ts
   * userinfoEndpoints: {
   *   user: "https://api.github.com/user",
   *   emails: "https://api.github.com/user/emails",
   * }
   * ```
   */
  userinfoEndpoints?: Record<string, string>;
  /**
   * Map what the provider told us about the user — id_token claims
   * (`undefined` for non-OIDC providers) and userinfo responses keyed as
   * configured (`undefined` unless `userinfoEndpoints` is set) — to the
   * account identity used at redemption. `id` becomes the provider account
   * id. Defaults to OIDC claims: `(claims) => ({ ...claims, id: claims.sub })`,
   * so providers without an id_token must supply this.
   */
  profile?: (
    claims: OidcClaims | undefined,
    // `any` so app mappings can dig into responses without casting.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    userInfoResponses: Record<string, any> | undefined,
  ) => { id: string; [key: string]: unknown };
  /** Scopes to request, e.g. `["openid", "email", "profile"]`. Omitted from the URL when absent. */
  scopes?: string[];
  /**
   * Send a PKCE `S256` challenge with the authorization request. Enable only
   * for providers that honor PKCE alongside the client secret (Google does);
   * some providers silently ignore it (GitHub OAuth apps), which this flag
   * should then reflect.
   */
  pkce?: boolean;
  /**
   * Extra query params for the authorization URL, e.g. Google's
   * `{ access_type: "offline" }`. Protocol params (`state`, `redirect_uri`,
   * ...) always win over entries here.
   */
  extraAuthorizationParams?: Record<string, string>;
  /**
   * Origins `redirectTo` may point at, e.g. `["https://app.example.com"]`.
   * Exact origin match; open-redirect prevention.
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
 * OAuth sign-in against a single upstream provider (IdP). Register one
 * instance per IdP; the instance's name is persisted to the accounts table
 * as the account's provider:
 *
 * ```ts
 * providers: [
 *   provider(Oauth("google"), { component: components.oauthGoogle, ... }),
 *   provider(Oauth("github"), { component: components.oauthGithub, ... }),
 * ]
 * ```
 *
 * The flow:
 *
 * 1. `signIn` (here): validate, mint `state`, record an authorization
 *    request in the component, and return the provider authorization URL
 *    for the client to navigate to plus the state it must hold onto.
 * 2. The provider redirects back to the component's HTTP callback, which
 *    claims the request, exchanges the code, and mints a one-time ticket.
 * 3. `redeem` (here): the client presents the one-time code from the
 *    callback redirect plus its original state, and gets back the session
 *    token bundle.
 *
 * The component is mounted once per IdP in `convex.config.ts`, each mount
 * with its own name, `httpPrefix`, and `CLIENT_ID`/`CLIENT_SECRET` bindings
 * (see the component's convex.config.ts); register
 * `<site-url><httpPrefix>/callback` as the redirect URI with each provider.
 */
export function Oauth<const N extends string>(name: N) {
  return defineProvider({
    name,
    setup: (helpers, options: OauthOptions) => {
      // Validate configuration up front so it fails at deploy time, not on
      // the first sign-in.
      const allowedOrigins = options.allowedRedirectOrigins.map((allowed) => {
        const url = parseUrl(allowed);
        if (url === null || url.origin === "null") {
          throw new Error(
            `allowedRedirectOrigins entry is not a valid origin: "${allowed}"`,
          );
        }
        return url.origin;
      });

      return {
        /**
         * Start an OAuth sign-in. The server mints `state` and returns it;
         * the client keeps it (it must present the same value again to
         * complete sign-in) and navigates to the returned `redirect` URL.
         */
        signIn: mutationGeneric({
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
            const codeVerifier = options.pkce
              ? generateRandomToken()
              : undefined;

            // Only the hash crosses the component boundary, so the raw state is
            // neither stored nor visible in function logs. Exchange config the
            // callback needs is stored on the request row; the mount's
            // CLIENT_ID comes back for the authorization URL.
            const stateHash = await sha256Hex(state);
            const { callbackBaseUrl, clientId } = await ctx.runMutation(
              options.component.provider.createAuthorizationRequest,
              {
                provider: name,
                stateHash,
                redirectTo: args.redirectTo,
                tokenEndpoint: options.tokenEndpoint,
                ...(codeVerifier === undefined ? {} : { codeVerifier }),
                ...(options.userinfoEndpoints === undefined
                  ? {}
                  : { userinfoEndpoints: options.userinfoEndpoints }),
                ...(options.issuer === undefined
                  ? {}
                  : { issuer: options.issuer }),
              },
            );

            // Protocol params come last so they win over extras. Set on
            // `searchParams` (rather than replacing `url.search`) to preserve
            // any params baked into the configured endpoint URL.
            const params: Record<string, string> = {
              ...options.extraAuthorizationParams,
              response_type: "code",
              client_id: clientId,
              redirect_uri: `${callbackBaseUrl}/callback`,
              state,
            };

            if (options.scopes !== undefined) {
              params.scope = options.scopes.join(" ");
            }

            if (codeVerifier !== undefined) {
              params.code_challenge = await sha256Base64Url(codeVerifier);
              params.code_challenge_method = "S256";
            }

            const url = new URL(options.authorizationEndpoint);
            for (const [key, value] of Object.entries(params)) {
              url.searchParams.set(key, value);
            }

            return { redirect: url.toString(), state };
          },
        }),

        /**
         * Complete an OAuth sign-in by redeeming the one-time `code` from
         * the callback redirect together with the state held since `signIn`.
         * Returns the session token bundle, or null when the code is
         * unknown, already redeemed, expired, or the state doesn't match —
         * all indistinguishable to the caller, like a failed
         * `refreshSession`.
         *
         * The component calls are subtransactions of this mutation, so a
         * failure anywhere (including the app rejecting the sign-in from
         * `createOrUpdateUser`) rolls back the ticket claim; only a
         * successful redemption consumes the ticket.
         */
        redeem: mutationGeneric({
          args: {
            code: v.string(),
            state: v.string(),
          },
          returns: v.union(vTokenBundle, v.null()),
          handler: async (ctx, args): Promise<TokenBundle | null> => {
            const ticket = await ctx.runMutation(
              options.component.provider.claimTicket,
              {
                provider: name,
                ottHash: await sha256Hex(args.code),
                stateHash: await sha256Hex(args.state),
              },
            );
            if (ticket === null) {
              return null;
            }

            // The default mapping covers OIDC providers; anything without
            // an id_token must configure `profile`.
            const profileFn =
              options.profile ??
              ((oidcClaims: OidcClaims | undefined) => {
                if (oidcClaims === undefined) {
                  throw new Error(
                    `Provider "${name}" returned no id_token, so a profile mapping is required`,
                  );
                }
                return { ...oidcClaims, id: oidcClaims.sub };
              });
            const profile = profileFn(
              ticket.claims as OidcClaims | undefined,
              ticket.userInfoResponses,
            );
            if (typeof profile.id !== "string" || profile.id === "") {
              throw new Error(
                `Profile mapping for provider "${name}" returned no id`,
              );
            }

            return await helpers.completeSignIn(ctx, {
              provider: name,
              providerAccountId: profile.id,
              profile,
            });
          },
        }),
      };
    },
  });
}
