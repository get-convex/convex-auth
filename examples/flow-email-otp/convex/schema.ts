import { defineSchema, defineTable } from "convex/server";
import { v } from "convex/values";

// The app owns `users`. Note: no codes, no pending-flow fields — those live
// in auth storage. A row in this table means someone who proved control of
// their email at least once.
export default defineSchema({
  users: defineTable({
    email: v.string(),
  }),
});
