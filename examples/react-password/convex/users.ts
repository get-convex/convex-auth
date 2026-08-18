import { internalMutation } from "./_generated/server";
import { v } from "convex/values";

/**
 * Create the user row for a new password account and return its id. The
 * provider supplies the username it just registered in `profile`.
 *
 * An `onSignIn` callback is optional, and this app has nothing to do when
 * someone signs back in, so it attaches only this one.
 */
export const onSignUp = internalMutation({
  args: {
    provider: v.literal("password"),
    providerAccountId: v.string(),
    profile: v.object({ username: v.string() }),
  },
  returns: v.id("users"),
  handler: async (ctx, args) => {
    return await ctx.db.insert("users", { username: args.profile.username });
  },
});
