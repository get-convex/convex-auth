import { query } from "./_generated/server";
import { components } from "./_generated/api";
import { Id } from "./_generated/dataModel";

/**
 * The currently signed-in user with their verified email addresses, or null.
 *
 * Demonstrates an authenticated query that reads from the authEmail
 * component.
 */
export const loggedInUser = query({
  args: {},
  handler: async (
    ctx,
  ): Promise<{
    id: Id<"users">;
    email: string;
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

    const emails = await ctx.runQuery(components.authEmail.public.getEmails, {
      userId,
    });
    return { id: user._id, email: user.email, emails };
  },
});
