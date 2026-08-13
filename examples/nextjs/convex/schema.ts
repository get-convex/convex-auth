import { defineSchema, defineTable } from "convex/server";
import { v } from "convex/values";

// Password sign-ups carry a username in the provider's profile; anonymous
// sign-ins carry no profile, so the column is optional.
export default defineSchema({
  users: defineTable({
    username: v.optional(v.string()),
  }),
});
