import { internalMutation } from "./_generated/server";
import { v } from "convex/values";

export const createOrUpdateUser = internalMutation({
  args: {
    provider: v.literal("password"),
    providerAccountId: v.string(),
    profile: v.object({ username: v.string() }),
    userId: v.union(v.id("users"), v.null()),
  },
  returns: v.id("users"),
  handler: async (ctx, args) => {
    if (args.userId !== null) {
      return args.userId;
    }
    return await ctx.db.insert("users", { username: args.profile.username });
  },
});
