import { mutation } from "./_generated/server.js";

/**
 * Creates an anonymous account in the `accounts` table.
 *
 * Returns the `anonymousId` stored in the table.
 */
export const createAnonymousAccount = mutation({
  args: {},
  handler: async (ctx) => {
    const anonymousId = crypto.randomUUID();
    await ctx.db.insert("accounts", { anonymousId });
    return anonymousId;
  },
});
