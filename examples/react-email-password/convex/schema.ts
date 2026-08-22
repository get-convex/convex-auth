import { defineSchema, defineTable } from "convex/server";
import { v } from "convex/values";

export default defineSchema({
  users: defineTable({
    // The address the user last signed in or up with. The full list of the
    // user's verified addresses lives in the authEmail component.
    email: v.string(),
  }),
});
