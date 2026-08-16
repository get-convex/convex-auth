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

  // One row for each validation flow that has started and is not complete.
  // The completion is a one-shot claim: the first `completeValidation` call
  // that finds the row deletes it.
  pendingValidations: defineTable({
    // The address under validation, with the case that the user gave. This is
    // the address the email goes to, and the address a completion records.
    email: v.string(),
    // The same address after normalization (see `normalizeEmail`). Lookups
    // and the checks against `verifiedEmails` use this field, not `email`.
    normalizedEmail: v.string(),
    // The user this validation is for.
    userId: v.string(),
    // What a successful completion does. See `vValidationPurposeArg`.
    purpose: v.union(
      v.object({ kind: v.literal("addEmail") }),
      v.object({ kind: v.literal("setEmail") }),
      v.object({ kind: v.literal("passwordReset") }),
    ),
    // SHA-256 of the code that travels in the emailed link. Only the hash is
    // stored, so database access alone cannot complete a validation.
    codeHash: v.string(),
    // SHA-256 of the secret that stays in the starting browser's storage.
    // Completion requires both the code and the secret.
    secretHash: v.string(),
    expiresAt: v.number(),
  })
    .index("by_codeHash", ["codeHash"])
    .index("by_userId", ["userId"])
    .index("by_normalizedEmail", ["normalizedEmail"]),
});
