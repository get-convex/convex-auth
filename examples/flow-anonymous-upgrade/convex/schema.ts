import { defineSchema, defineTable } from "convex/server";
import { v } from "convex/values";

// The app owns `users`. Anonymous users are ordinary rows — `isAnonymous`
// is an app field, not an auth concept — so guest data (`todos`) references
// them exactly like it would any signed-up user.
export default defineSchema({
  users: defineTable({
    isAnonymous: v.boolean(),
    email: v.optional(v.string()),
  }),
  todos: defineTable({
    userId: v.id("users"),
    text: v.string(),
  }).index("by_user", ["userId"]),
});
