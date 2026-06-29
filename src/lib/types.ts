import { FunctionReference } from "convex/server";

import { Infer, v } from "convex/values";

/**
 * Shared contracts that cross the core/app boundary. That includes validators (and
 * their inferred types) for what the core's session functions accept and return
 * and any function references. Each is declared once here and reused wherever the
 * core or the app needs it, so the shapes can never drift between declaration sites.
 */

/**
 * The session a successful sign-in (or refresh) mints: a short-lived access
 * token plus the rotating refresh token, with their expiries and the app user
 * id the access token is minted for.
 */
export const vTokenBundle = v.object({
  accessToken: v.string(),
  accessTokenExpiresAt: v.number(),
  refreshToken: v.string(),
  refreshTokenExpiresAt: v.number(),
  userId: v.string(),
});

export type TokenBundle = Infer<typeof vTokenBundle>;

/**
 * Shared identity-claims contract between the *provider* components that
 * authenticate users and the *core* component.
 *
 * After a provider authenticates a user it produces this plain payload; the app
 * forwards it to the core's `signIn`, which turns it into a session. Providers
 * never call the core directly, they only know how to produce these claims.
 */
export const vAuthClaims = v.object({
  /** Provider name, e.g. "password". */
  provider: v.string(),
  /** Stable, provider-scoped account identifier (e.g. a username). */
  providerAccountId: v.string(),
  /** Arbitrary profile data the provider learned about the user. */
  profile: v.any(),
});

export type AuthClaims = Infer<typeof vAuthClaims>;

export const vCreateOrUpdateUser = v.object({
  provider: v.string(),
  providerAccountId: v.string(),
  profile: v.any(),
  userId: v.union(v.string(), v.null()),
});

/**
 * This function type represents the core entrypoint for an application
 * to integrate its user model with Convex Auth.
 *
 * It will be called in two scenarios, both associated with a user signing in:
 *
 *  1. The first time a user signs in with an account from a provider.
 *    * The `userId` argument will not be present in this case.
 *    * The application should create a new user record or use trusted data
 *      (e.g. a verified email) in the `profile` to link to an existing
 *      user record.
 *    * The `_id` of the newly created user should be the return value.
 *  2. Subsequent sign ins from a provider
 *    * The `userId` argument will be present.
 *    * The application may use the data in `profile` to update or otherwise
 *      modify the stored user record.
 *    * The existing `userId` must be the return value.
 *
 * The application keeps ownership of its users table — the core only holds a
 * reference to this one mutation.
 *
 * If an application wants to reject a sign in, it can throw a `ConvexError`
 * and the entire sign in attempt will be blocked.
 */
export type CreateOrUpdateUserFn = FunctionReference<
  "mutation",
  "internal",
  Infer<typeof vCreateOrUpdateUser>,
  string
>;
