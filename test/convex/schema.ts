import { defineSchema, defineTable } from "convex/server";
import { v } from "convex/values";
import { authTables } from "@xixixao/convex-auth/server";

export default defineSchema({
  ...authTables,
  users: defineTable({
    name: v.optional(v.string()),
    email: v.string(),
    emailVerified: v.boolean(),
    image: v.optional(v.string()),
    phone: v.optional(v.string()), // from google
    bio: v.optional(v.string()), // from github
  }).index("email", ["email"]),
  numbers: defineTable({
    userId: v.id("users"),
    value: v.number(),
  }).index("userId", ["userId"]),
});
