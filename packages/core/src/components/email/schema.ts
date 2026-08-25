import { defineSchema, defineTable } from "convex/server";
import { v } from "convex/values";
import { vEmailSource } from "./validation.ts";

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
    // How the address got verified. See `vEmailSource`.
    source: vEmailSource,
  })
    .index("by_normalizedEmail", ["normalizedEmail"])
    .index("by_userId", ["userId"])
    .index("by_userId_isPrimary", ["userId", "isPrimary"]),

  // One row for each challenge. A challenge proves that the person who
  // started it owns an email address. A row is pending until `challenge.complete`
  // marks it completed (`proofHash` set), and is deleted when
  // `verifiedEmails.add` spends the proof, or when it expires.
  challenges: defineTable({
    // The address under challenge, with the case that the user gave. This is
    // the address the email goes to, and the address a spent proof records.
    email: v.string(),
    // The user the challenge is bound to, when the caller gave one at start.
    // A proof from a challenge without a user cannot be spent with
    // `verifiedEmails.add`; it only proves ownership of the address.
    userId: v.optional(v.string()),
    // Opaque to the component. `challenge.complete` requires the same value
    // the caller gave at start, so a link for one flow cannot complete another.
    purpose: v.string(),
    // SHA-256 of the code that travels in the emailed link. Only the hash is
    // stored, so database access alone cannot complete a challenge.
    codeHash: v.string(),
    // SHA-256 of the secret that stays in the starting browser's storage.
    // Completion requires both the code and the secret.
    secretHash: v.string(),
    // SHA-256 of the proof that `challenge.complete` returned. Present only
    // on a completed challenge.
    proofHash: v.optional(v.string()),
    expiresAt: v.number(),
  })
    .index("by_codeHash", ["codeHash"])
    .index("by_proofHash", ["proofHash"])
    .index("by_userId", ["userId"]),
});
