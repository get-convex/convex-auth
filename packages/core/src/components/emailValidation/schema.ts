import { defineSchema, defineTable } from "convex/server";
import { v } from "convex/values";

export default defineSchema({
  // One pending email-validation session per attempt. A new sign-up for the
  // same user replaces the prior row (single active session per user), so
  // `by_userId` is used both to look up and to delete stale rows.
  emailValidationSessions: defineTable({
    userId: v.string(),
    email: v.string(),
    // SHA-256 of the client-held session secret (the bearer half of
    // `<id>.<secret>`) and of the short code emailed out-of-band. Both must
    // match to confirm.
    secretHash: v.bytes(),
    codeHash: v.bytes(),
    expiresAt: v.number(),
  }).index("by_userId", ["userId"]),
});
