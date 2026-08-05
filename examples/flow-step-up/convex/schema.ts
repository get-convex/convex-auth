import { defineSchema, defineTable } from "convex/server";
import { v } from "convex/values";

// The app owns `users`. Session freshness (last-verified timestamps) lives
// in auth storage, not here — the schema needs nothing for step-up.
export default defineSchema({
  users: defineTable({
    email: v.string(),
  }),
});
