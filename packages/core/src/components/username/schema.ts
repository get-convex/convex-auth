import { defineSchema, defineTable } from "convex/server";
import { v } from "convex/values";

export default defineSchema({
  // One row for each user that has a username. The component only sees an
  // opaque app `userId` string.
  usernames: defineTable({
    userId: v.string(),
    // The username as the user supplied it. Applications show this value.
    username: v.string(),
    // The username after normalization (see `normalizeUsername`). The
    // component compares usernames with this value, so that two usernames
    // that look the same to a user cannot both exist.
    usernameNormalized: v.string(),
  })
    // A user has one username at most, and a username belongs to one user
    // at most. The component keeps both properties true. Convex does not
    // enforce unique indexes.
    .index("by_userId", ["userId"])
    .index("by_usernameNormalized", ["usernameNormalized"]),
});
