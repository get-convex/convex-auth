import { defineSchema, defineTable } from "convex/server";
import { v } from "convex/values";

export default defineSchema({
  users: defineTable({
    username: v.string(),
  }).index("by_username", ["username"]),
  passwords: defineTable({
    userId: v.string(),
    passwordHashPHC: v.string(),
  }).index("by_userId", ["userId"]),
});
