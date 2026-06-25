import { Infer, v } from "convex/values";

/**
 * Shared *value* contracts that cross the core/app boundary: the validators (and
 * their inferred types) for what the core's session functions accept and return.
 * Each is declared once here and reused wherever the core or the app needs it,
 * so the wire shapes can never drift between declaration sites.
 *
 * Function-signature types (e.g. the provider hand-off callbacks) and intent
 * enums live with the code that owns them, not here.
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
 * The result of resolving a provider identity *without* minting a session: the
 * claims as given, plus the existing app user id if that identity is already
 * known. Lets the app decide what to do (sign in, link, create) before any
 * session exists.
 */
export const vAccountResolution = v.object({
  provider: v.string(),
  providerAccountId: v.string(),
  profile: v.any(),
  existingUserId: v.optional(v.string()),
});

export type AccountResolution = Infer<typeof vAccountResolution>;

/**
 * The result of linking a provider identity onto an existing app user.
 * `linked` is `false` when the identity was already linked to that same user
 * (the call is idempotent), `true` when a new link was created.
 */
export const vAccountLink = v.object({
  linked: v.boolean(),
  userId: v.string(),
});

export type AccountLink = Infer<typeof vAccountLink>;
