import { defineSchema, defineTable } from "convex/server";

export default defineSchema({
  // The row holds no email address. The verified addresses of a user live in
  // the authEmail component.
  users: defineTable({}),
});
