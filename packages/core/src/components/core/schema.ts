import { defineSchema, defineTable } from "convex/server";
import { v } from "convex/values";

/**
 * A sign-in check as the core stores it: the requirement's name, and a
 * function handle to the query that judges it.
 */
export const vStoredSignInCheck = v.object({
  requirement: v.string(),
  handle: v.string(),
});

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

  // One row per sign-in that a provider has verified but not finished: its
  // credentials checked out, and something else (a second factor, say) must
  // happen before a session is minted. The row holds what minting needs later
  // and, as function handles, the provider's sign-in checks: the queries the
  // core runs again each time the sign-in is continued to learn what is still
  // outstanding. What a sign-in must satisfy is thus fixed when it is parked.
  //
  // The client continues the sign-in with a random attempt token, stored here
  // only as its SHA-256 hash. The row's id is handed out as the `attemptId`
  // that requirement components key their own proof by, so the token itself
  // never leaves the core, the provider, and the requirement's own functions.
  //
  // An identity has at most one pending sign-in. A fresh sign-in replaces the
  // row rather than patching it, so the new attempt gets a new id and proof
  // recorded against the old one cannot satisfy it.
  pendingSignIns: defineTable({
    attemptTokenHash: v.string(),
    provider: v.string(),
    providerAccountId: v.string(),
    userId: v.string(),
    profile: v.any(),
    // The provider's sign-in checks (see `SignInCheck` in lib/types.ts): the
    // name of each requirement, next to a handle to the check that judges it.
    checks: v.array(vStoredSignInCheck),
    // A handle to the app's `onSignIn` for this provider, to run when the
    // sign-in completes. Absent when the app attached none.
    onSignInHandle: v.optional(v.string()),
    expiresAt: v.number(),
  })
    .index("by_attempt_hash", ["attemptTokenHash"])
    .index("by_provider_account", ["provider", "providerAccountId"])
    .index("by_expires_at", ["expiresAt"]),
});
