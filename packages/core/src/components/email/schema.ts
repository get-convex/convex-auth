import { defineSchema, defineTable } from "convex/server";
import { v } from "convex/values";

export default defineSchema({
  // One row for each verified email address.
  //
  // Invariants the component keeps true:
  // - An email address belongs to at most one user.
  // - A user with at least one email has exactly one primary email.
  verifiedEmails: defineTable({
    // The address with the case that the user gave. The app shows this value
    // to the end user.
    email: v.string(),
    // The same address after normalization (see `normalizeEmail`). Lookups and
    // uniqueness checks use this field, not `email`.
    normalizedEmail: v.string(),
    userId: v.string(),
    // `true` for the user's primary address.
    // The primary address can be used by the app when it needs to email
    // a particular user (e.g. for security notifications).
    isPrimary: v.boolean(),
  })
    .index("by_normalizedEmail", ["normalizedEmail"])
    .index("by_userId", ["userId"])
    .index("by_userId_isPrimary", ["userId", "isPrimary"]),

  // One row for each challenge that has started and is not complete.
  // The completion is a one-shot claim: the first `challenge.complete` call
  // that finds the row deletes it.
  challenges: defineTable({
    // The address under challenge, with the case that the user gave. This is
    // the address the email goes to, and the address a completion records.
    // Lookups use `normalizeEmail` on this value; the row keeps no
    // normalized copy, because nothing looks a challenge up by address.
    email: v.string(),
    // The kind of the challenge, which is the file in `challenge/` that
    // started it. Each kind completes in its own way, and each carries the
    // user that the flow is for. A `custom` challenge also carries the
    // caller's purpose string, which is opaque here, and its user is the one
    // that the caller asserted, or `null` when no user is signed in (see
    // `challenge/custom.ts`).
    purpose: v.union(
      v.object({ kind: v.literal("addEmail"), userId: v.string() }),
      v.object({ kind: v.literal("setPrimaryEmail"), userId: v.string() }),
      v.object({
        kind: v.literal("custom"),
        userId: v.union(v.string(), v.null()),
        purpose: v.string(),
      }),
    ),
    // SHA-256 of the code that travels in the emailed link. Only the hash is
    // stored, so database access alone cannot complete a challenge.
    codeHash: v.string(),
    // SHA-256 of the secret that stays in the starting browser's storage.
    // Completion requires both the code and the secret.
    secretHash: v.string(),
    expiresAt: v.number(),
  })
    .index("by_codeHash", ["codeHash"])
    .index("by_purpose_userId", ["purpose.userId"]),
});
