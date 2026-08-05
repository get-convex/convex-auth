import { defineSchema, defineTable } from "convex/server";
import { v } from "convex/values";

// The app owns `users`. Note: no identities, no sessions, no passkeys, no
// verification timestamps — all of that lives in auth storage. The security
// page renders entirely from auth queries; the app schema stays minimal.
export default defineSchema({
  users: defineTable({
    email: v.string(),
  }),
});
