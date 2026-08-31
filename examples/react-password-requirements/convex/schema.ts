import { defineSchema, defineTable } from "convex/server";
import { v } from "convex/values";
import { mathFactor } from "./lib/mathFactor";

export default defineSchema({
  users: defineTable({
    username: v.string(),
  }),

  // The math factor owns its challenge table; mounting it here is part of
  // what the factor's setup value provides (alongside its requirement spec
  // and its endpoint handlers).
  ...mathFactor.tables,
});
