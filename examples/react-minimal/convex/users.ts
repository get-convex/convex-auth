import { internalMutation } from "./_generated/server";
import { v } from "convex/values";

export const createOrUpdateUser = internalMutation({
  args: {
    provider: v.literal("anonymous"),
    providerAccountId: v.string(),
    profile: v.object({}),
    userId: v.union(v.id("users"), v.null()),
  },
  returns: v.id("users"),
  handler: async (ctx, args) => {
    if (args.userId !== null) {
      return args.userId;
    }
    return ctx.db.insert("users", {});
  },
});
