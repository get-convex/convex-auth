import { Infer, v } from "convex/values";
import { defineProvider } from "../../lib/types";
import {
  setupOauth,
  type OauthCatalog,
  type OauthProfile,
  type OauthProviderOptions,
} from "./setup";

/**
 * The account profile the Google provider produces. Google is OIDC, so
 * identity comes from validated id_token claims; this is the exact shape the
 * mapping emits, so the app can validate against it precisely.
 */
export const vGoogleProfile = v.object({
  /** Google's `sub` claim — the stable provider account id. */
  id: v.string(),
  email: v.optional(v.string()),
  /**
   * True when Google attested the email as verified (the `email_verified`
   * claim). False means unverified *or* the claim was absent — either way,
   * don't trust the email for account linking.
   */
  emailVerified: v.boolean(),
  name: v.optional(v.string()),
  picture: v.optional(v.string()),
});

export type GoogleProfile = Infer<typeof vGoogleProfile>;

/**
 * Map validated Google id_token claims to {@link GoogleProfile}. Google returns
 * an id_token, so `claims` is always present here; a missing one is a bug.
 */
export const normalizeGoogleProfile: OauthProfile = (claims) => {
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

/** How to talk to Google: endpoints, scopes, and the profile mapping. */
const googleCatalog: OauthCatalog = {
  authorizationEndpoint: "https://accounts.google.com/o/oauth2/v2/auth",
  tokenEndpoint: "https://oauth2.googleapis.com/token",
  issuer: "https://accounts.google.com",
  scopes: ["openid", "email", "profile"],
  pkce: true,
  profile: normalizeGoogleProfile,
};

/**
 * Built-in Google OAuth provider. Register it with its own oauth component
 * mount:
 *
 * ```ts
 * provider(OauthGoogle, {
 *   component: components.oauthGoogle,
 *   allowedRedirectOrigins: ["https://app.example.com", "http://localhost:5173"],
 * })
 * ```
 *
 * Mount the component under `httpPrefix: "/oauth/google"` in
 * convex.config.ts, binding Google's `CLIENT_ID`/`CLIENT_SECRET`, and register
 * `<site-url>/oauth/google/callback` as the redirect URI with Google. The
 * mount's prefix alone determines the callback URL.
 */
export const OauthGoogle = defineProvider({
  name: "google",
  setup: (helpers, options: OauthProviderOptions) => {
    const { startSignIn, completeSignIn } = setupOauth(
      "google",
      googleCatalog,
      helpers,
      options,
    );
    return {
      startSignInGoogle: startSignIn,
      completeSignInGoogle: completeSignIn,
    };
  },
});
