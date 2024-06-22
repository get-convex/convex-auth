import { defineSchema, defineTable } from "convex/server";
import { v } from "convex/values";
import { authTables } from "@xixixao/convex-auth/server";

export default defineSchema({
  ...authTables,
  messages: defineTable({
    userId: v.id("users"),
    body: v.string(),
  }),
});
