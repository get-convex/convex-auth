/**
 * The Apple OAuth provider, exported at
 * `@convex-dev/auth/providers/oauth/apple`.
 *
 * @module
 */
import { mutationGeneric } from "convex/server";
import { Infer, v } from "convex/values";
import type { UserCallbacks } from "../../lib/types.ts";
import type { AuthCore } from "../../components/core/setup.ts";
import { sha256Hex } from "../../lib/crypto.ts";
import { generateRandomToken } from "../component/crypto.ts";
import {
  buildCompleteSignIn,
  parseUrl,
  validateAllowedRedirectOrigins,
  type OidcClaims,
} from "../shared/redemption.ts";
import type { ComponentApi } from "./_generated/component.ts";
import { AUTHORIZATION_ENDPOINT, PROVIDER_NAME, SCOPES } from "./constants.ts";
import type { SanitizedAppleUser } from "./user.ts";

export type { SanitizedAppleUser };

/**
 * The account profile the Apple provider produces. Apple is OIDC, so
 * identity comes from validated id_token claims, with the name (when there
 * is one) coming from the callback instead. This is the exact shape the
 * mapping emits, so the app can validate against it precisely.
 */
export const vAppleProfile = v.object({
  /** Apple's `sub` claim, the stable provider account id. */
  id: v.string(),
  /**
   * The email Apple attested. It is a per-app relay address
   * (`...@privaterelay.appleid.com`) for anyone who chose to hide theirs.
   *
   * Optional for two reasons: Apple only sends it when the email scope was
   * granted, and a Managed Apple Account may have no address at all, since
   * schools often issue none.
   */
  email: v.optional(v.string()),
  /**
   * True when Apple attested the email as verified (the `email_verified`
   * claim). Apple returns verified addresses for personal Apple Accounts, so
   * a false comes from Sign in with Apple at Work & School or from the claim
   * being absent.
   */
  emailVerified: v.boolean(),
  /**
   * The name the person gave at sign-up, if they gave one. Apple sends it
   * exactly once, on the first authorization, and never again, so a return
   * visit produces a profile without it. It is also the one part of the
   * profile the browser relayed rather than Apple attesting to it, which
   * makes it user-controlled display data: escape it like any other text a
   * user typed, and don't key anything off it.
   */
  name: v.optional(v.string()),
});

export type AppleProfile = Infer<typeof vAppleProfile>;

/**
 * Map Apple's validated id_token claims, plus the sanitized name from a
 * first authorization, to {@link AppleProfile}.
 *
 * `user` is undefined on every sign-in after the first, which is why the
 * profile's `name` is optional. An app that wants to keep the name should
 * store it when it arrives and leave the stored one alone when it doesn't.
 */
export function normalizeAppleProfile(
  claims: OidcClaims,
  user: SanitizedAppleUser | undefined,
): AppleProfile {
  const parts = [user?.name.firstName, user?.name.lastName].filter(
    (part) => part !== undefined,
  );
  return {
    id: claims.sub,
    email: claims.email,
    // Apple sends the string "true"/"false" for some accounts and a boolean
    // for others.
    emailVerified:
      claims.email_verified === true || claims.email_verified === "true",
    name: parts.length === 0 ? undefined : parts.join(" "),
  };
}

/** App-defined config for setting up the Apple provider. */
export type AppleProviderOptions = {
  /** The Apple oauth component instance, i.e. `components.oauthApple`. */
  component: ComponentApi;
  /**
   * Origins `redirectTo` may point at, e.g. `["https://app.example.com"]`
   * for open-redirect prevention.
   */
  allowedRedirectOrigins: string[];
};

/**
 * Built-in Apple OAuth provider ("Sign in with Apple"). Wire it up with the
 * Apple oauth component:
 *
 * ```ts
 * export const { startSignInApple, completeSignInApple } = setupApple(core, {
 *   component: components.oauthApple,
 *   allowedRedirectOrigins: ["https://app.example.com", "http://localhost:5173"],
 * }).attachUserCallbacks({ createUser: internal.users.createUserApple });
 * ```
 *
 * Setup:
 *
 * 1. Install the component in convex.config.ts under
 *    `httpPrefix: "/oauth/apple"`, binding the Services ID, team id, key id,
 *    and `.p8` private key.
 * 2. Register `<site-url>/oauth/apple/callback` as a return URL on the
 *    Services ID, along with the `convex.site` domain it is on.
 *
 * The `httpPrefix` alone determines the callback URL, on the deployment's
 * `convex.site` host. Apple has to accept that host as a return URL and
 * rejects `localhost` and IP addresses, so the deployment has to be publicly
 * reachable. The app the flow returns to is unaffected and can stay on
 * localhost.
 */
export function setupApple<UsersTable extends string>(
  core: AuthCore<UsersTable>,
  options: AppleProviderOptions,
) {
  // Validate the app-supplied options up front so mistakes fail at deploy
  // time.
  const allowedOrigins = validateAllowedRedirectOrigins(
    options.allowedRedirectOrigins,
  );

  return {
    /**
     * Supply the app's user callbacks (see {@link UserCallbacks} for how their
     * args must be declared) and get this provider's functions to export.
     */
    attachUserCallbacks(
      callbacks: UserCallbacks<"apple", AppleProfile, UsersTable>,
    ) {
      const { authMutation } = core.bindProvider({
        name: PROVIDER_NAME,
        createUser: callbacks.createUser,
        onSignIn: callbacks.onSignIn,
      });

      /**
       * Start an Apple sign-in. The server mints `state` and returns it; the
       * client keeps it (it must present the same value again to complete
       * sign-in) and navigates to the returned `redirect` URL.
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

          // Apple supports no PKCE, so state is the whole of the binding
          // between this request and the callback that answers it.
          const state = generateRandomToken();
          const { clientId, callbackUrl } = await ctx.runMutation(
            options.component.provider.createAuthorizationRequest,
            { stateHash: await sha256Hex(state), redirectTo: args.redirectTo },
          );

          const url = new URL(AUTHORIZATION_ENDPOINT);
          const params: Record<string, string> = {
            response_type: "code",
            // Asking for any scope obliges us to take the callback as a POST.
            response_mode: "form_post",
            client_id: clientId,
            redirect_uri: callbackUrl,
            scope: SCOPES.join(" "),
            state,
          };
          for (const [key, value] of Object.entries(params)) {
            url.searchParams.set(key, value);
          }

          return { redirect: url.toString(), state };
        },
      });

      /**
       * Complete an Apple sign-in by redeeming the one-time `code` from the
       * callback redirect together with the state held since `startSignIn`.
       */
      const completeSignIn = buildCompleteSignIn<
        AppleProfile,
        { claims?: OidcClaims; callbackParams?: { user?: SanitizedAppleUser } }
      >({
        providerName: PROVIDER_NAME,
        authMutation,
        claimTicket: (ctx, args) =>
          ctx.runMutation(options.component.provider.claimTicket, args),
        profile: (payload) => {
          if (payload.claims === undefined) {
            throw new Error(
              "Apple returned no id_token to build a profile from",
            );
          }
          return normalizeAppleProfile(
            payload.claims,
            payload.callbackParams?.user,
          );
        },
      });

      return {
        startSignInApple: startSignIn,
        completeSignInApple: completeSignIn,
      };
    },
  };
}
