import { v } from "convex/values";
import { internalMutation, query } from "./_generated/server";
import { vGoogleProfile } from "@convex-dev/auth/providers/oauth/google";

/**
 * Create the user row for a new Google account and return its id. This example
 * keeps no data in the row, but your app can put a profile here.
 */
export const createUser = internalMutation({
  args: {
    provider: v.literal("google"),
    providerAccountId: v.string(),
    profile: vGoogleProfile,
  },
  returns: v.id("users"),
  handler: async (ctx) => {
    return await ctx.db.insert("users", {});
  },
});

export const getCurrentUser = query({
  args: {},
  handler: async (ctx) => {
    const identity = await ctx.auth.getUserIdentity();
    if (identity === null) {
      return null;
    }
    const userId = ctx.db.normalizeId("users", identity.subject);
    if (userId === null) {
      return null;
    }
    const user = await ctx.db.get("users", userId);
    if (user === null) {
      return null;
    }
    return { id: user._id };
  },
});
