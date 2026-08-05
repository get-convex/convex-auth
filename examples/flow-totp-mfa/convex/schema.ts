import { defineSchema, defineTable } from "convex/server";
import { v } from "convex/values";

// The app owns `users`. `totpEnrolled` is denormalized app-side purely for
// UI (show the enrollment section vs. the disable button); the TOTP secret
// and the backup-code hashes live in auth storage, never here.
export default defineSchema({
  users: defineTable({
    email: v.string(),
    totpEnrolled: v.boolean(),
  }),
});
