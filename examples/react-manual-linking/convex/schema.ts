import { defineSchema, defineTable } from "convex/server";
import { v } from "convex/values";

export default defineSchema({
  users: defineTable({
    // Set once a username/password account is linked or signed in.
    username: v.optional(v.string()),
  }),
});
