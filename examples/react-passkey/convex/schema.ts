import { defineSchema, defineTable } from "convex/server";
import { v } from "convex/values";

export default defineSchema({
  users: defineTable({
    // The username is optional: the passkey provider creates the user row
    // before the WebAuthn ceremony, and the username arrives only when the
    // ceremony completes. A row without a username is an abandoned
    // registration; this leak is accepted by design.
    username: v.optional(v.string()),
  }),
});
