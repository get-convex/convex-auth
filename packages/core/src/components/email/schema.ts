import { defineSchema, defineTable } from "convex/server";
import { v } from "convex/values";

export default defineSchema({
  // One row for each verified email address. Invariants the component keeps
  // true (Convex does not enforce unique indexes):
  // - An email address belongs to at most one user.
  // - A user with at least one email has exactly one primary email.
  // - The first email of a user becomes the primary email.
  // TODO: add a set-primary operation.
  emails: defineTable({
    // The email address after normalization (see `normalizeEmail`).
    email: v.string(),
    userId: v.string(),
    // `true` for the user's primary address. The primary address receives
    // security notifications.
    isPrimary: v.boolean(),
  })
    .index("by_email", ["email"])
    .index("by_userId", ["userId"])
    .index("by_userId_isPrimary", ["userId", "isPrimary"]),
});
