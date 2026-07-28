import { defineSchema, defineTable } from "convex/server";
import { v } from "convex/values";

// A minimal app schema for the full email+password flow. The app owns its users
// table; email validation requires `email` to be **optional** (the users row is
// created at sign-up, before the address is confirmed) and a `by_email` index to
// enforce uniqueness at confirmation time.
export default defineSchema({
  users: defineTable({
    email: v.optional(v.string()),
  }).index("by_email", ["email"]),
});
