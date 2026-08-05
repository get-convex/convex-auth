import { defineSchema, defineTable } from "convex/server";
import { v } from "convex/values";

// The app owns `users`. Every row was created with a fully validated
// profile — there is no such thing as a partially-onboarded user, because
// validation happens BEFORE the account exists.
export default defineSchema({
  users: defineTable({
    email: v.string(),
    displayName: v.string(),
    role: v.union(
      v.literal("engineer"),
      v.literal("designer"),
      v.literal("other"),
    ),
    tosAcceptedVersion: v.string(),
  }),
});
