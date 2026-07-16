import { mutationGeneric } from "convex/server";
import { v } from "convex/values";
import {
  defineProvider,
  vTokenBundle,
  type TokenBundle,
} from "../../lib/types";
import type { ComponentApi } from "./_generated/component.js";
import { CALLBACK_PATH } from "./constants";
import {
  decryptWithToken,
  generateRandomToken,
  sha256Base64Url,
  sha256Hex,
} from "./crypto";

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
  /**
   * The `httpPrefix` this IdP's component is mounted under in
   * convex.config.ts, e.g. `"/oauth/google"`. Must match that mount: the
   * OAuth `redirect_uri` is built app-side as
   * `${CONVEX_SITE_URL}${httpPrefix}/callback` because the component itself
   * can't see the system env var (a typed-env component's `process.env`
   * only contains its bound vars). A mismatch surfaces on the first sign-in
   * attempt as the provider rejecting an unregistered redirect URI.
   */
  httpPrefix: string;
  /** The provider's authorization endpoint, e.g. Google's `https://accounts.google.com/o/oauth2/v2/auth`. */
  authorizationEndpoint: string;
  /** The provider's token endpoint, e.g. Google's `https://oauth2.googleapis.com/token`. */
  tokenEndpoint: string;
  /**
   * Expected `iss` of the provider's id_tokens, e.g. Google's
   * `https://accounts.google.com`. Required for every OIDC provider:
   * `sub` is only unique within an issuer, so a token endpoint that serves
   * multiple issuers (multi-tenant IdPs) could otherwise collide account
   * identities. The callback rejects any returned id_token unless this is
   * set and matches. Omit only for plain-OAuth providers that never return
   * an id_token (e.g. GitHub).
   */
  issuer?: string;
  /**
   * Profile endpoints the callback fetches with the access token after the
   * code exchange (GET with a bearer token; provider variation lives in the
   * URL's query params). Keys name each response in the `profile` mapping's
   * second argument; only the `profile` mapping sees the responses, so this
   * option requires one. Required for providers that don't return an OIDC
   * id_token, e.g. GitHub:
   *
   * ```ts
   * userInfoEndpoints: {
   *   user: "https://api.github.com/user",
   *   emails: "https://api.github.com/user/emails",
   * }
   * ```
   */
  userInfoEndpoints?: Record<string, string>;
  /**
   * Map what the provider told us about the user — id_token claims
   * (`undefined` for non-OIDC providers) and userinfo responses keyed as
   * configured (`undefined` unless `userInfoEndpoints` is set) — to the
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
   * `{ access_type: "offline" }`. Must not include protocol params
   * (`state`, `redirect_uri`, `code_challenge`, ...); setup rejects them so
   * they can never silently conflict with what `signIn` sends.
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
 * Require an absolute https URL (plain http is allowed only for localhost,
 * for development against a local IdP). Credentials and tokens travel to
 * these endpoints, so a typo'd scheme must not downgrade them to cleartext.
 */
function requireHttpsUrl(value: string, label: string): void {
  const url = parseUrl(value);
  if (url === null) {
    throw new Error(`${label} is not a valid URL: "${value}"`);
  }
  const isLocalhost =
    url.hostname === "localhost" ||
    url.hostname.endsWith(".localhost") ||
    url.hostname === "127.0.0.1" ||
    url.hostname === "[::1]";
  if (url.protocol !== "https:" && !(url.protocol === "http:" && isLocalhost)) {
    throw new Error(`${label} must use https: "${value}"`);
  }
}

/** Params `signIn` sets itself; `extraAuthorizationParams` may not. */
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
 *
 * The callback only accepts GET redirects. Providers that POST it
 * (`response_mode=form_post`, notably Apple when name/email scopes are
 * requested) are not supported yet.
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
      if (!/^\/\S+[^/\s]$/.test(options.httpPrefix)) {
        throw new Error(
          `httpPrefix for provider "${name}" must start with "/" and not end with "/", e.g. "/oauth/google"`,
        );
      }
      requireHttpsUrl(options.authorizationEndpoint, "authorizationEndpoint");
      requireHttpsUrl(options.tokenEndpoint, "tokenEndpoint");
      if (options.userInfoEndpoints !== undefined) {
        // The default profile mapping only reads id_token claims, so
        // userinfo responses would be fetched and never used.
        if (options.profile === undefined) {
          throw new Error(
            `userInfoEndpoints for provider "${name}" requires a \`profile\` mapping`,
          );
        }
        const entries = Object.entries(options.userInfoEndpoints);
        if (entries.length === 0) {
          throw new Error(
            `userInfoEndpoints for provider "${name}" must have at least one entry`,
          );
        }
        for (const [key, endpoint] of entries) {
          // Keys become Convex record field names on the authorization
          // request row, which allow only printable ASCII up to 1024
          // characters, not starting with "$".
          if (
            !/^[ -~]+$/.test(key) ||
            key.length > 1024 ||
            key.startsWith("$")
          ) {
            throw new Error(
              `userInfoEndpoints key "${key}" for provider "${name}" must be printable ASCII, at most 1024 characters, and not start with "$"`,
            );
          }
          requireHttpsUrl(endpoint, `userInfoEndpoints["${key}"]`);
        }
      }
      for (const key of Object.keys(options.extraAuthorizationParams ?? {})) {
        if (PROTOCOL_PARAMS.includes(key)) {
          throw new Error(
            `extraAuthorizationParams for provider "${name}" must not set protocol param "${key}"`,
          );
        }
      }

      return {
        /**
         * Start an OAuth sign-in. The server mints `state` and returns it;
         * the client keeps it (it must present the same value again to
         * complete sign-in) and navigates to the returned `redirect` URL.
         *
         * The state is the client's proof at redemption that it initiated
         * this flow. Keep it in private storage (e.g. sessionStorage) and
         * never read it from a URL: a client that accepts state from URL
         * params can be handed an attacker's flow and complete sign-in into
         * the attacker's account (login CSRF).
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

            // The redirect_uri is built here, app-side, because the
            // component can't see the system env var. It's stored on the
            // request row so the code exchange presents the byte-identical
            // value, as OAuth requires.
            const siteUrl = process.env.CONVEX_SITE_URL;
            if (siteUrl === undefined) {
              throw new Error("CONVEX_SITE_URL is not set");
            }
            const callbackUrl = `${siteUrl}${options.httpPrefix}${CALLBACK_PATH}`;

            // Only the hash crosses the component boundary, so the raw state is
            // neither stored nor visible in function logs. Exchange config the
            // callback needs is stored on the request row; the mount's
            // CLIENT_ID comes back for the authorization URL.
            const stateHash = await sha256Hex(state);
            const { clientId } = await ctx.runMutation(
              options.component.provider.createAuthorizationRequest,
              {
                provider: name,
                stateHash,
                redirectTo: args.redirectTo,
                callbackUrl,
                tokenEndpoint: options.tokenEndpoint,
                codeVerifier,
                userInfoEndpoints: options.userInfoEndpoints,
                issuer: options.issuer,
              },
            );

            // Protocol params come last, and setup rejects extras that name
            // them, so they can never be overridden. Set on `searchParams`
            // (rather than replacing `url.search`) to preserve any params
            // baked into the configured endpoint URL.
            const params: Record<string, string> = {
              ...options.extraAuthorizationParams,
              response_type: "code",
              client_id: clientId,
              redirect_uri: callbackUrl,
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
         * The state must be the value stored at sign-in time, never one
         * read from a URL. Returns the session token bundle, or null when
         * the code is unknown, already redeemed, expired, or the state
         * doesn't match — all indistinguishable to the caller, like a
         * failed `refreshSession`.
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

            // The ticket found by hash proves `code` is the token the
            // payload was encrypted under, so decryption only fails on
            // corruption.
            const { claims, userInfoResponses } = JSON.parse(
              await decryptWithToken(args.code, ticket.payload),
            ) as {
              claims: OidcClaims | undefined;
              userInfoResponses: Record<string, unknown> | undefined;
            };

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
            const profile = profileFn(claims, userInfoResponses);
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
