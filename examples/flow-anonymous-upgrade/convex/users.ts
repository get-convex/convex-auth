import { query } from "./_generated/server";
import { Id } from "./_generated/dataModel";

/** The currently signed-in user (anonymous or upgraded), or null. */
export const currentUser = query({
  args: {},
  handler: async (ctx) => {
    const identity = await ctx.auth.getUserIdentity();
    if (identity === null) {
      return null;
    }
    const user = await ctx.db.get(
      "users",
      identity.subject as Id<"users">,
    );
    if (user === null) {
      return null;
    }
    return { id: user._id, email: user.email, isAnonymous: user.isAnonymous };
  },
});
