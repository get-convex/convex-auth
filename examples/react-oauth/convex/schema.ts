import { defineSchema, defineTable } from "convex/server";
import { v } from "convex/values";

export default defineSchema({
  users: defineTable({
    verifiedEmail: v.string(),
  }).index("verifiedEmail", ["verifiedEmail"]),
});
