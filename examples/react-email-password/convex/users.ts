import { internalMutation } from "./_generated/server";
import { v } from "convex/values";

export const createUser = internalMutation({
  args: {
    provider: v.object({
      name: v.literal("emailPassword"),
      accountId: v.string(),
      profile: v.object({}),
    }),
  },
  returns: v.id("users"),
  handler: async (ctx) => {
    return await ctx.db.insert("users", {});
  },
});
