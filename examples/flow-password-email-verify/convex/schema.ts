import { defineSchema, defineTable } from "convex/server";
import { v } from "convex/values";

// The app owns `users`. Note: no password hash, no verification codes, no
// pending-signup fields — those live in auth storage. A row in this table
// means a real, email-verified user.
export default defineSchema({
  users: defineTable({
    email: v.string(),
  }),
});
