/**
 * Everything about Apple that never varies between apps. This component
 * serves Apple only, so these are constants rather than configuration.
 */

/** Where the browser is sent to sign in. */
export const AUTHORIZATION_ENDPOINT =
  "https://appleid.apple.com/auth/authorize";

/** Where the authorization code is exchanged for tokens. */
export const TOKEN_ENDPOINT = "https://appleid.apple.com/auth/token";

/** The `iss` claim Apple's id_tokens carry. */
export const ISSUER = "https://appleid.apple.com";

/**
 * What the sign-in asks for. Apple puts the email in the id_token whenever
 * the email scope was granted, and relays the name through the browser only
 * on the first authorization. Requesting either scope is also what makes
 * Apple post the callback rather than redirect to it.
 */
export const SCOPES = ["name", "email"] as const;

/** The name this provider's accounts are namespaced under in the core. */
export const PROVIDER_NAME = "apple";

/**
 * Apple's only documented callback error code. It means the user declined,
 * which is what the standard `access_denied` means everywhere else.
 */
export const USER_CANCELLED_ERROR = "user_cancelled_authorize";
