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

  // One row per active refresh token (sessions). The raw refresh token is never
  // stored — only its SHA-256 hash.
  //
  // `previousRefreshTokenHash` keeps the *just-rotated* token briefly valid (a
  // short grace window) so that two near-simultaneous refreshes presenting the
  // same token — e.g. parallel SSR loaders, or two browser tabs sharing one
  // cookie — don't fight: the first rotates, the second still resolves via the
  // previous hash instead of being rejected and logging the user out.
  sessions: defineTable({
    userId: v.string(),
    accountId: v.id("accounts"),
    refreshTokenHash: v.string(),
    refreshTokenExpiresAt: v.number(),
    previousRefreshTokenHash: v.optional(v.string()),
    previousRefreshTokenExpiresAt: v.optional(v.number()),
    lastRefreshedAt: v.number(),
  })
    .index("by_refresh_hash", ["refreshTokenHash"])
    .index("by_previous_refresh_hash", ["previousRefreshTokenHash"])
    .index("by_user", ["userId"]),
});
