import { internalMutation } from "./_generated/server";
import { v } from "convex/values";

/**
 * Every anonymous sign-in establishes a new account, so this app only needs a
 * sign-up callback: create the user row and return its id.
 */
export const onSignUp = internalMutation({
  args: {
    provider: v.literal("anonymous"),
    providerAccountId: v.string(),
    profile: v.object({}),
  },
  returns: v.id("users"),
  handler: async (ctx) => {
    return await ctx.db.insert("users", {});
  },
});
