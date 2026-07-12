import { mutation } from "./_generated/server";

/**
 * Creates an anonymous account in the `accounts` table.
 *
 * Returns the `anonymousId` stored in the table.
 */
export const createOauthAccount = mutation({
  args: {},
  handler: async (ctx) => {
    const anonymousId = crypto.randomUUID();
    await ctx.db.insert("accounts", { providerAccountId: anonymousId });
    return anonymousId;
  },
});
