import { internalMutation } from "./_generated/server";
import { v } from "convex/values";

/**
 * Create the user row for a new passkey account and return its id. This
 * example keeps no data in the row, but your app can put a profile here.
 */
export const createUser = internalMutation({
  args: {
    provider: v.literal("passkey"),
    providerAccountId: v.string(),
    // The passkey provider's profile username is nullable: it reads the
    // username back from the username component, which returns `null` when the
    // app has removed it.
    profile: v.object({ username: v.union(v.string(), v.null()) }),
  },
  returns: v.id("users"),
  handler: async (ctx) => {
    return await ctx.db.insert("users", {});
  },
});
