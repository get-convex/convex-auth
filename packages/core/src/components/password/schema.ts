import { defineSchema, defineTable } from "convex/server";
import { v } from "convex/values";

export default defineSchema({
  passwords: defineTable({
    userId: v.string(),
    passwordHashPHC: v.string(), // format: https://github.com/C2SP/C2SP/blob/main/phc-strings.md
  }).index("by_userId", ["userId"]),
});
