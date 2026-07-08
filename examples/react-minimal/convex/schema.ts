import { defineSchema, defineTable } from "convex/server";
import { v } from "convex/values";

export default defineSchema({
  // No users table: the app uses the provider account id (the JWT subject)
  // directly as the author identity.
  messages: defineTable({
    authorId: v.string(),
    authorName: v.string(),
    body: v.string(),
  }).index("by_author", ["authorId"]),
  users: defineTable({
    name: v.string(),
  }),
});
