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
