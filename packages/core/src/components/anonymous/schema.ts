import { defineSchema, defineTable } from "convex/server";
import { v } from "convex/values";

export default defineSchema({
  accounts: defineTable({
    anonymousId: v.string(),
    lastSignIn: v.number(),
  }).index("by_anonymousId", ["anonymousId"]),
});
