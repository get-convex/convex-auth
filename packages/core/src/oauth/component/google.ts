import { Infer, v } from "convex/values";
import type { UserCallbacks } from "../../lib/types";
import type { AuthCore } from "../../components/core/setup";
import {
  setupOauth,
  type OauthCatalog,
  type OauthProfile,
  type OauthProviderOptions,
} from "./setup";

/**
 * The account profile the Google provider produces. Google is OIDC, so
 * identity comes from validated id_token claims. This is the exact shape the
 * mapping emits, so the app can validate against it precisely.
 */
export const vGoogleProfile = v.object({
  /** Google's `sub` claim, the stable provider account id. */
  id: v.string(),
  email: v.optional(v.string()),
  /**
   * True when Google attested the email as verified (the `email_verified`
   * claim). False means unverified or the claim was absent, so don't trust
   * the email for account linking.
   */
  emailVerified: v.boolean(),
  name: v.optional(v.string()),
  picture: v.optional(v.string()),
});

export type GoogleProfile = Infer<typeof vGoogleProfile>;

/**
 * Map validated Google id_token claims to {@link GoogleProfile}. Google
 * returns an id_token, so `claims` is always present here. A missing one is
 * a bug.
 */
export const normalizeGoogleProfile: OauthProfile<GoogleProfile> = (claims) => {
  if (claims === undefined) {
    throw new Error("Google returned no id_token to build a profile from");
  }
  return {
    id: claims.sub,
    email: claims.email,
    emailVerified: claims.email_verified === true,
    name: claims.name,
    picture: claims.picture,
  };
};

/** Google's endpoints, scopes, and profile mapping. */
const googleCatalog: OauthCatalog<GoogleProfile> = {
  authorizationEndpoint: "https://accounts.google.com/o/oauth2/v2/auth",
  tokenEndpoint: "https://oauth2.googleapis.com/token",
  // Google documents both forms, with or without the https prefix.
  issuer: ["https://accounts.google.com", "accounts.google.com"],
  scopes: ["openid", "email", "profile"],
  pkce: true,
  profile: normalizeGoogleProfile,
};

/**
 * Built-in Google OAuth provider. Wire it up with its own oauth component
 * instance:
 *
 * ```ts
 * export const { startSignInGoogle, completeSignInGoogle } = setupGoogle(core, {
 *   component: components.oauthGoogle,
 *   allowedRedirectOrigins: ["https://app.example.com", "http://localhost:5173"],
 * }).attachUserCallbacks({ createUser: internal.users.createUserGoogle });
 * ```
 *
 * Setup:
 *
 * 1. Install the component in convex.config.ts under
 *    `httpPrefix: "/oauth/google"`, binding Google's `CLIENT_ID` and
 *    `CLIENT_SECRET`.
 * 2. Register `<site-url>/oauth/google/callback` as the redirect URI with
 *    Google.
 *
 * The `httpPrefix` alone determines the callback URL.
 */
export function setupGoogle<UsersTable extends string>(
  core: AuthCore<UsersTable>,
  options: OauthProviderOptions,
) {
  return {
    /**
     * Supply the app's user callbacks (see {@link UserCallbacks} for how their
     * args must be declared) and get this provider's functions to export.
     */
    attachUserCallbacks(
      callbacks: UserCallbacks<"google", GoogleProfile, UsersTable>,
    ) {
      const { startSignIn, completeSignIn } = setupOauth(
        core,
        "google",
        googleCatalog,
        callbacks,
        options,
      );
      return {
        startSignInGoogle: startSignIn,
        completeSignInGoogle: completeSignIn,
      };
    },
  };
}
