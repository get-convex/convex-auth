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

  // The hashes of refresh tokens that rotation has replaced.
  //
  // This allows tracing a previously rotated token back to its session. A
  // presented token that matches a document here is one of two things,
  // depending on the age of the document (tracked by the system-added
  // `_creationTime` field):
  //
  //  - Rotated away moments ago: two near-simultaneous refreshes presenting
  //    the same token (parallel SSR loaders, or two browser tabs sharing one
  //    cookie). The first rotated; the second still resolves here instead of
  //    being rejected and logging the user out.
  //  - Rotated away longer ago: a token that should be in nobody's hands, so
  //    it is treated as stolen and its session is revoked.
  spentRefreshTokens: defineTable({
    hash: v.string(),
    sessionId: v.id("sessions"),
  })
    .index("by_hash", ["hash"])
    .index("by_session", ["sessionId"]),
});
