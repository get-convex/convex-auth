import { defineSchema, defineTable } from "convex/server";
import { v } from "convex/values";

export default defineSchema({
  // Maps a provider-scoped identity to an opaque app user id. The app owns the
  // actual users table; we only store the id string it gives us back.
  accounts: defineTable({
    provider: v.string(),
    providerAccountId: v.string(),
    userId: v.string(),
  })
    .index("by_provider_account", ["provider", "providerAccountId"])
    .index("by_user", ["userId"]),

  // One row per active session, holding only the *current* refresh token's
  // SHA-256 hash. The raw refresh token is never stored.
  sessions: defineTable({
    userId: v.string(),
    accountId: v.id("accounts"),
    refreshTokenHash: v.string(),
    refreshTokenExpiresAt: v.number(),
    lastRefreshedAt: v.number(),
  })
    .index("by_refresh_hash", ["refreshTokenHash"])
    .index("by_user", ["userId"]),

  // The hashes of refresh tokens that rotation has replaced, so a token the
  // component issued can still be traced back to its session after it stops
  // being current. A presented token that lands here is one of two things,
  // told apart by how long ago the row was created:
  //
  //  - Rotated away moments ago: two near-simultaneous refreshes presenting
  //    the same token (parallel SSR loaders, or two browser tabs sharing one
  //    cookie). The first rotated; the second still resolves here instead of
  //    being rejected and logging the user out.
  //  - Rotated away longer ago: a token that should be in nobody's hands, so
  //    it is treated as stolen and its session is revoked.
  //
  // Without this table the second case is invisible: an out-of-grace token
  // matches nothing and a thief keeps the session indefinitely.
  //
  // `_creationTime` is both the grace clock and the retention key, so the row
  // carries no timestamps of its own.
  spentRefreshTokens: defineTable({
    hash: v.string(),
    sessionId: v.id("sessions"),
  })
    .index("by_hash", ["hash"])
    .index("by_session", ["sessionId"]),
});
