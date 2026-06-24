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


/**
 * The shape of the app's user-persistence callback. The app passes
 * `internal.users.upsertFromAuth` (or equivalent) as `createOrUpdateUser`;
 * typing it here gives a compile error if that mutation's args/return drift from
 * what the core expects. The app keeps ownership of its users table — the core
 * only holds a reference to this one mutation.
 *
 * It serves every auth path: sign-in calls it with no `userId` the first time
 * an identity is seen (create the user, return the id) and with the resolved
 * `userId` on every later sign-in (update the user from the latest profile);
 * `linkToCurrentUser` calls it with the already-known `userId` (sync the
 * provider profile onto that user). Apps that don't need to react to the update
 * paths can simply ignore `userId`.
 */
export type CreateOrUpdateUserFn = FunctionReference<
  "mutation",
  "internal",
  {
    provider: string;
    providerAccountId: string;
    profile: Record<string, unknown>;
    userId?: string;
  },
  string
>;