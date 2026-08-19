import { defineSchema, defineTable } from "convex/server";
import { v } from "convex/values";

// Password sign-ups carry a username in the provider's profile; anonymous
// sign-ins carry no profile, so the column is optional. `lastSignedInAt` is
// maintained by this app's own callbacks (see convex/users.ts).
export default defineSchema({
  users: defineTable({
    username: v.optional(v.string()),
    lastSignedInAt: v.optional(v.number()),
  }),
});
