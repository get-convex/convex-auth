import { query } from "./_generated/server";
import { Id } from "./_generated/dataModel";

/**
 * The currently signed-in user, or null.
 *
 * Demonstrates an authenticated query.
 */
export const loggedInUser = query({
  args: {},
  handler: async (ctx) => {
    const identity = await ctx.auth.getUserIdentity();
    if (identity === null) {
      return null;
    }
    const userId = identity.subject as Id<"users">;
    const user = await ctx.db.get("users", userId);
    if (user === null) {
      return null;
    }

    return { id: user._id, username: user.username ?? null };
  },
});
