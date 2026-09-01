import { defineSchema, defineTable } from "convex/server";
import { v } from "convex/values";

export default defineSchema({
  users: defineTable({
    /**
     * Apple sends the name only on the very first authorization, so it has
     * to be stored to be used reliably.
     */
    name: v.optional(v.string()),
    email: v.optional(v.string()),
  }),
});
