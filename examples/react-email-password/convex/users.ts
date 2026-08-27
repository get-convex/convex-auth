import { internalMutation } from "./_generated/server";
import { v } from "convex/values";

export const createUser = internalMutation({
  args: {
    provider: v.literal("emailPassword"),
    providerAccountId: v.string(),
    profile: v.object({ email: v.string() }),
  },
  returns: v.id("users"),
  handler: async (ctx, args) => {
    return await ctx.db.insert("users", { email: args.profile.email });
  },
});

export const onSignIn = internalMutation({
  args: {
    provider: v.literal("emailPassword"),
    providerAccountId: v.string(),
    profile: v.object({ email: v.string() }),
    userId: v.id("users"),
  },
  returns: v.null(),
  handler: async (ctx, args) => {
    // Keep the stored address in sync with the one the user signed in with.
    await ctx.db.patch("users", args.userId, { email: args.profile.email });
    return null;
  },
});
