import { internalMutation } from "./_generated/server";
import { v } from "convex/values";

/**
 * Create the user row for a new email + password account and return its id.
 *
 * The profile is empty on purpose. The email address is not verified at
 * sign-up, and the authEmail component is the source of truth for the
 * verified addresses of a user. Read them with
 * `components.authEmail.verifiedEmails.getEmails` (see `currentUser.ts`).
 * Your app can put other profile data in this row.
 */
export const createUser = internalMutation({
  args: {
    provider: v.literal("emailPassword"),
    providerAccountId: v.string(),
    profile: v.object({}),
  },
  returns: v.id("users"),
  handler: async (ctx) => {
    return await ctx.db.insert("users", {});
  },
});
