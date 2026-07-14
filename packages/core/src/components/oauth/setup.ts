import { mutationGeneric } from "convex/server";
import { v } from "convex/values";
import { defineProvider } from "../../lib/types";
import type { ComponentApi } from "./_generated/component.js";
import { generateRandomToken, sha256Base64Url, sha256Hex } from "./crypto";

/**
 * Configuration for a single upstream OAuth provider (IdP).
 */
export type OauthProviderConfig = {
  /** The OAuth client id issued by the provider. */
  clientId: string;
  /** The provider's authorization endpoint, e.g. Google's `https://accounts.google.com/o/oauth2/v2/auth`. */
  authorizationEndpoint: string;
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
};

/**
 * Options for {@link Oauth}.
 */
export type OauthOptions = {
  /** The mounted oauth component (`components.authOauth`). */
  component: ComponentApi;
  /** Upstream providers keyed by name; the key is used in routes, claims, and account identity. */
  providers: Record<string, OauthProviderConfig>;
  /**
   * Origins `redirectTo` may point at, e.g. `["https://app.example.com"]`.
   * Exact origin match; open-redirect prevention.
   */
  allowedRedirectOrigins: string[];
};

/**
 * Client-generated state is opaque, but a guessable value would let an
 * attacker inject their authorization code into a victim's flow, so a
 * minimum length is enforced (32 base64url chars ≈ 192 bits). The cap just
 * bounds work done on hostile input.
 */
const MIN_STATE_LENGTH = 32;
const MAX_STATE_LENGTH = 256;

/** `new URL` without the exception: returns null on unparseable input. */
function parseUrl(value: string): URL | null {
  try {
    return new URL(value);
  } catch {
    return null;
  }
}

/**
 * OAuth sign-in against configured upstream providers. The flow:
 *
 * 1. `signIn` (here): validate, record an authorization request in the
 *    component, return the provider authorization URL for the client to
 *    navigate to.
 * 2. The provider redirects back to the component's HTTP callback, which
 *    claims the request, exchanges the code, and mints a one-time ticket.
 * 3. The caller redeems the ticket (plus its original state) to complete
 *    sign-in.
 *
 * The component must be mounted with an `httpPrefix` in `convex.config.ts`
 * (e.g. `app.use(oauthProvider, { httpPrefix: "/oauth" })`) so the callback
 * is routable; register `<site-url><httpPrefix>/callback/<provider>` as the
 * redirect URI with each provider.
 */
export const Oauth = defineProvider({
  name: "oauth",
  setup: (_helpers, options: OauthOptions) => {
    const { component } = options;

    // Normalize the allowlist up front so misconfiguration fails at deploy
    // time, not on the first sign-in.
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
       * Start an OAuth sign-in. The client generates and keeps `state` (it
       * must present the same value again to complete sign-in), then
       * navigates to the returned `redirect` URL.
       */
      signInOauth: mutationGeneric({
        args: {
          provider: v.string(),
          state: v.string(),
          redirectTo: v.string(),
        },
        returns: v.object({ redirect: v.string() }),
        handler: async (ctx, args) => {
          const providerConfig = options.providers[args.provider];
          if (providerConfig === undefined) {
            throw new Error(`Unknown OAuth provider "${args.provider}"`);
          }

          if (
            args.state.length < MIN_STATE_LENGTH ||
            args.state.length > MAX_STATE_LENGTH
          ) {
            throw new Error(
              `state must be between ${MIN_STATE_LENGTH} and ${MAX_STATE_LENGTH} characters`,
            );
          }

          const redirectTo = parseUrl(args.redirectTo);
          if (redirectTo === null) {
            throw new Error("redirectTo must be an absolute URL");
          }
          if (!allowedOrigins.includes(redirectTo.origin)) {
            throw new Error(
              `redirectTo origin "${redirectTo.origin}" is not in allowedRedirectOrigins`,
            );
          }

          const codeVerifier = providerConfig.pkce
            ? generateRandomToken()
            : undefined;

          // Only the hash crosses the component boundary, so the raw state is
          // neither stored nor visible in function logs.
          const stateHash = await sha256Hex(args.state);
          const callbackBaseUrl = await ctx.runMutation(
            component.provider.createAuthorizationRequest,
            {
              provider: args.provider,
              stateHash,
              redirectTo: args.redirectTo,
              ...(codeVerifier === undefined ? {} : { codeVerifier }),
            },
          );

          // Protocol params come last so they win over extras. Set on
          // `searchParams` (rather than replacing `url.search`) to preserve
          // any params baked into the configured endpoint URL.
          const params: Record<string, string> = {
            ...providerConfig.extraAuthorizationParams,
            response_type: "code",
            client_id: providerConfig.clientId,
            redirect_uri: `${callbackBaseUrl}/callback/${args.provider}`,
            state: args.state,
          };

          if (providerConfig.scopes !== undefined) {
            params.scope = providerConfig.scopes.join(" ");
          }

          if (codeVerifier !== undefined) {
            params.code_challenge = await sha256Base64Url(codeVerifier);
            params.code_challenge_method = "S256";
          }

          const url = new URL(providerConfig.authorizationEndpoint);
          for (const [key, value] of Object.entries(params)) {
            url.searchParams.set(key, value);
          }

          return { redirect: url.toString() };
        },
      }),
    };
  },
});
