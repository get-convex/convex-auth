import { mutationGeneric } from "convex/server";
import { v } from "convex/values";
import { defineProvider } from "../../lib/types";
import type { ComponentApi } from "./_generated/component.js";
import { generateRandomToken, sha256Base64Url, sha256Hex } from "./crypto";

/**
 * Configuration for a single upstream OAuth provider (IdP).
 */
export type OauthProviderConfig = {
  /**
   * This IdP's component mount (e.g. `components.oauthGoogle`). The
   * component is mounted once per IdP so each mount can bind its own
   * `CLIENT_SECRET` and serve its own callback route.
   */
  component: ComponentApi;
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
  /** Upstream providers keyed by name; the key is used in claims and account identity. */
  providers: Record<string, OauthProviderConfig>;
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
 * OAuth sign-in against configured upstream providers. The flow:
 *
 * 1. `signIn` (here): validate, mint `state`, record an authorization
 *    request in the component, and return the provider authorization URL
 *    for the client to navigate to plus the state it must hold onto.
 * 2. The provider redirects back to the component's HTTP callback, which
 *    claims the request, exchanges the code, and mints a one-time ticket.
 * 3. The caller redeems the ticket (plus its original state) to complete
 *    sign-in.
 *
 * The component is mounted once per IdP in `convex.config.ts`, each mount
 * with its own name, `httpPrefix`, and `CLIENT_SECRET` binding (see the
 * component's convex.config.ts); register `<site-url><httpPrefix>/callback`
 * as the redirect URI with each provider.
 */
export const Oauth = defineProvider({
  name: "oauth",
  setup: (_helpers, options: OauthOptions) => {
    // Validate configuration up front so it fails at deploy time, not on
    // the first sign-in.
    for (const [name, config] of Object.entries(options.providers)) {
      if (config.clientId === "") {
        throw new Error(`OAuth provider "${name}" has an empty clientId`);
      }
    }

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
      signInOauth: mutationGeneric({
        args: {
          provider: v.string(),
          redirectTo: v.string(),
        },
        returns: v.object({ redirect: v.string(), state: v.string() }),
        handler: async (ctx, args) => {
          // `hasOwn` rather than an undefined check: a lookup like
          // "constructor" hits the prototype chain and returns a function.
          if (!Object.hasOwn(options.providers, args.provider)) {
            throw new Error(`Unknown OAuth provider "${args.provider}"`);
          }
          const providerConfig = options.providers[args.provider];

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
          const codeVerifier = providerConfig.pkce
            ? generateRandomToken()
            : undefined;

          // Only the hash crosses the component boundary, so the raw state is
          // neither stored nor visible in function logs.
          const stateHash = await sha256Hex(state);
          const callbackBaseUrl = await ctx.runMutation(
            providerConfig.component.provider.createAuthorizationRequest,
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
            redirect_uri: `${callbackBaseUrl}/callback`,
            state,
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

          return { redirect: url.toString(), state };
        },
      }),
    };
  },
});
