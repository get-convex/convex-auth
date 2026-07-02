import { defineSchema, defineTable } from "convex/server";
import { v } from "convex/values";

export default defineSchema({
  // One row per user with a password set, keyed by the opaque app user id. The
  // raw password is never stored — only `passwordHash`, a PHC string (argon2id)
  // that embeds the algorithm, its parameters, and the salt. Storing the full
  // PHC string keeps hash upgrades a drop-in later: a verify can re-read the
  // stored parameters and rehash when they fall behind the current policy.
  passwords: defineTable({
    userId: v.string(),
    passwordHash: v.string(),
  }).index("by_userId", ["userId"]),
});
