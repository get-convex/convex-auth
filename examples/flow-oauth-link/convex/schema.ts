import { defineSchema, defineTable } from "convex/server";
import { v } from "convex/values";

// The app owns `users`. Note: no OAuth identities, no provider tokens, no
// pending-link state — those live in auth storage. A row here is a real
// user; `name` comes from the provider profile when available.
export default defineSchema({
  users: defineTable({
    email: v.string(),
    name: v.optional(v.string()),
  }),
});
