import { defineSchema, defineTable } from "convex/server";

// Anonymous sign-in carries no profile, so a user row is just its identity
// (system fields). A real app would add its own columns here.
export default defineSchema({
  users: defineTable({}),
});
