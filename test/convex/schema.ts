import { defineSchema, defineTable } from "convex/server";
import { v } from "convex/values";
import { authTables } from "@xixixao/convex-auth/server";

export default defineSchema({
  ...authTables,
  numbers: defineTable({
    userId: v.id("users"),
    value: v.number(),
  }).index("userId", ["userId"]),
});
