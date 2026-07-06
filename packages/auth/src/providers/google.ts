/**
 * Google OAuth provider.
 *
 * ```ts
 * import { google } from "@robelest/convex-auth/providers/google";
 *
 * google({
 *   clientId: env.AUTH_GOOGLE_ID!,
 *   clientSecret: env.AUTH_GOOGLE_SECRET!,
 * })
 * ```
 *
 * @module
 */

import { Google as ArcticGoogle } from "arctic";

import { createArcticOAuthClient, createOAuthProvider } from "../server/oauth/factory";
import { defaultOAuthRedirectUri } from "./redirect";

const DEFAULT_SCOPES = ["openid", "profile", "email"];

/** Configuration for the {@link google} provider. */
export interface GoogleConfig {
  /** OAuth client ID from the Google Cloud console. */
  clientId: string;
  /** OAuth client secret from the Google Cloud console. */
  clientSecret: string;
  /** Optional callback URL override. Defaults to the auth site URL plus `/callback/google`. */
  redirectUri?: string;
  /** Optional OAuth scopes. Defaults to `openid profile email`. */
  scopes?: string[];
  /** Account-linking strategy for existing users with matching email addresses. */
  accountLinking?: "verifiedEmail" | "none";
  /** On returning sign-in, refresh `User.name`/`image`/`email` from the new profile. Defaults to `true`. */
  updateProfileOnLogin?: boolean;
}

/**
 * Create a Google OAuth provider.
 *
 * Uses the Google OpenID Connect flow and requests `openid profile email` by
 * default.
 *
 * @param config - Google OAuth client settings.
 * @returns A configured Google OAuth provider for `defineAuth`.
 * @throws {Error} When no callback URL can be derived and `redirectUri` is omitted.
 *
 * @example
 * ```ts
 * import { google } from "@robelest/convex-auth/providers/google";
 *
 * google({
 *   clientId: env.AUTH_GOOGLE_ID!,
 *   clientSecret: env.AUTH_GOOGLE_SECRET!,
 * })
 * ```
 */
export function google(config: GoogleConfig) {
  const scopes = config.scopes ?? DEFAULT_SCOPES;
  const createProvider = (redirectUri?: string) =>
    new ArcticGoogle(
      config.clientId,
      config.clientSecret,
      config.redirectUri ?? defaultOAuthRedirectUri("google", redirectUri),
    );
  return createOAuthProvider({
    id: "google",
    provider: createArcticOAuthClient(createProvider, { pkce: "required" }),
    scopes,
    accountLinking: config.accountLinking,
    updateProfileOnLogin: config.updateProfileOnLogin,
  });
}
