import { defineSchema, defineTable } from "convex/server";
import { v } from "convex/values";

// A minimal app schema. The app owns its users table; the auth components only
// keep the opaque user-id string it returns.
export default defineSchema({
  users: defineTable({
    email: v.string(),
  })
    // Email is unique. Convex has no declarative unique constraints; every
    // insert goes through `createOrUpdateUser`, which checks this index first
    // (safe because mutations are serializable transactions).
    .index("email", ["email"]),
});
