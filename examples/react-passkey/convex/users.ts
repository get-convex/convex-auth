import { internalMutation } from "./_generated/server";
import { v } from "convex/values";

/**
 * Create the user row for a new passkey account and return its id. The
 * provider supplies the username it just registered in `profile`.
 */
export const createUser = internalMutation({
  args: {
    provider: v.literal("passkey"),
    providerAccountId: v.string(),
    profile: v.object({ username: v.string() }),
  },
  returns: v.id("users"),
  handler: async (ctx, args) => {
    return await ctx.db.insert("users", { username: args.profile.username });
  },
});
