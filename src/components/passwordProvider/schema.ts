import { defineSchema, defineTable } from "convex/server";
import { v } from "convex/values";

export default defineSchema({
  passwords: defineTable({
    userId: v.string(),
    passwordHash: v.string(), // PHC string
  }).index("by_userId", ["userId"]),
});
