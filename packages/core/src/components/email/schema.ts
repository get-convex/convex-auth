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
  challenges: defineTable({
    // The address under challenge, with the case that the user gave.
    email: v.string(),
    // The kind of the challenge, i.e. the type of flow that caused it.
    // Different flows have different effects on completion.
    purpose: v.union(
      // On completion, adds the verified email to `verifiedEmails` as the primary email address.
      // If there is already another primary email address, remove it.
      // Useful for apps that assume there is only a single email address per user.
      v.object({ kind: v.literal("setPrimaryEmail"), userId: v.string() }),
      // On completion, adds the verified email to `verifiedEmails`.
      // If there is already another primary email address, the new email address will be added as secondary.
      // Useful for apps that support multiple email addresses per user.
      v.object({ kind: v.literal("addEmail"), userId: v.string() }),
    ),
    // SHA-256 of the code that travels in the emailed link.
    // Storing the hash, so that even if database rows leak they can’t be used to complete the challenge.
    emailCodeHash: v.string(),
    // SHA-256 of the secret that stays in the starting browser’s storage.
    // Completion finds the row by this hash, then requires the code too.
    // Storing the hash, so that even if database rows leak they can’t be used to complete the challenge.
    browserSecretHash: v.string(),
    expiresAt: v.number(),
  })
    .index("by_browserSecretHash", ["browserSecretHash"])
    .index("by_purpose_userId", ["purpose.userId"]),
});
