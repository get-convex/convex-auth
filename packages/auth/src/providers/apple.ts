/**
 * Apple OAuth provider.
 *
 * ```ts
 * import { apple } from "@robelest/convex-auth/providers/apple";
 *
 * apple({
 *   clientId: env.AUTH_APPLE_ID!,
 *   teamId: env.AUTH_APPLE_TEAM_ID!,
 *   keyId: env.AUTH_APPLE_KEY_ID!,
 *   privateKey: env.AUTH_APPLE_PRIVATE_KEY!,
 * })
 * ```
 *
 * @module
 */

import { Apple as ArcticApple } from "arctic";

import { createArcticOAuthClient, createOAuthProvider } from "../server/oauth/factory";
import { defaultOAuthRedirectUri } from "./redirect";

const DEFAULT_SCOPES = ["name", "email"];

/** Configuration for the {@link apple} provider. */
export interface AppleConfig {
  /** Services ID or app bundle identifier registered with Sign in with Apple. */
  clientId: string;
  /** Apple Developer team identifier used to sign client secrets. */
  teamId: string;
  /** Apple private key identifier. */
  keyId: string;
  /** Apple private key PEM contents or bytes. */
  privateKey: string | Uint8Array;
  /** Optional callback URL override. Defaults to the auth site URL plus `/callback/apple`. */
  redirectUri?: string;
  /** Optional OAuth scopes. Defaults to `name email`. */
  scopes?: string[];
  /** Account-linking strategy for existing users with matching email addresses. */
  accountLinking?: "verifiedEmail" | "none";
  /** On returning sign-in, refresh `User.name`/`image`/`email` from the new profile. Defaults to `true`. */
  updateProfileOnLogin?: boolean;
}

/**
 * Create an Apple OAuth provider.
 *
 * @param config - Apple Sign In client settings and signing key material.
 * @returns A configured Apple OAuth provider for `defineAuth`.
 * @throws {Error} When no callback URL can be derived and `redirectUri` is omitted.
 *
 * @example
 * ```ts
 * import { apple } from "@robelest/convex-auth/providers/apple";
 *
 * apple({
 *   clientId: env.AUTH_APPLE_ID!,
 *   teamId: env.AUTH_APPLE_TEAM_ID!,
 *   keyId: env.AUTH_APPLE_KEY_ID!,
 *   privateKey: env.AUTH_APPLE_PRIVATE_KEY!,
 * })
 * ```
 */
export function apple(config: AppleConfig) {
  const privateKey =
    typeof config.privateKey === "string"
      ? config.privateKey
      : new TextDecoder().decode(config.privateKey);
  const scopes = config.scopes ?? DEFAULT_SCOPES;
  const createProvider = (redirectUri?: string) =>
    new ArcticApple(
      config.clientId,
      config.teamId,
      config.keyId,
      new TextEncoder().encode(privateKey),
      config.redirectUri ?? defaultOAuthRedirectUri("apple", redirectUri),
    );
  return createOAuthProvider({
    id: "apple",
    provider: createArcticOAuthClient(createProvider, { pkce: "never" }),
    scopes,
    accountLinking: config.accountLinking,
    updateProfileOnLogin: config.updateProfileOnLogin,
  });
}
