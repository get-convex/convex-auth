import { query } from "./_generated/server";
import { components } from "./_generated/api";
import { Id } from "./_generated/dataModel";

/**
 * The signed-in user with their verified email addresses, or null.
 *
 * The users table holds no address: the query reads the verified addresses
 * from the authEmail component.
 */
export const loggedInUser = query({
  args: {},
  handler: async (
    ctx,
  ): Promise<{
    id: Id<"users">;
    emails: { email: string; isPrimary: boolean }[];
  } | null> => {
    const identity = await ctx.auth.getUserIdentity();
    if (identity === null) {
      return null;
    }
    const userId = identity.subject as Id<"users">;
    const user = await ctx.db.get("users", userId);
    if (user === null) {
      return null;
    }

    const emails = await ctx.runQuery(
      components.authEmail.verifiedEmails.getEmails,
      {
        userId,
      },
    );
    return { id: user._id, emails };
  },
});
