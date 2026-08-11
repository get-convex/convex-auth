import { internalMutation } from "./_generated/server";
import { v } from "convex/values";

export const createOrUpdateUser = internalMutation({
  args: {
    provider: v.literal("anonymous"),
    providerAccountId: v.string(),
    profile: v.object({}),
    userId: v.union(v.string(), v.null()),
  },
  returns: v.id("users"),
  handler: async (ctx, args) => {
    if (args.userId !== null) {
      const existing = ctx.db.normalizeId("users", args.userId);
      if (existing === null) {
        throw new Error(`Unknown user id: ${args.userId}`);
      }
      return existing;
    }
    return ctx.db.insert("users", {});
  },
});
