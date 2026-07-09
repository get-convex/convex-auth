import { defineSchema, defineTable } from "convex/server";
import { v } from "convex/values";

// A minimal app schema. The app owns its users table; the auth components only
// keep the opaque user-id string it returns.
export default defineSchema({
  users: defineTable({
    username: v.optional(v.string()),
  }),
});
