import { v } from "convex/values";
import { Id } from "./_generated/dataModel";
import { internalMutation, query } from "./_generated/server";

/**
 * The app's create-or-update-user callback (see `attachUserCallback`). The core
 * invokes it on every sign-in — without a `userId` the first time an identity is
 * seen, and with the resolved `userId` thereafter. On the first anonymous
 * sign-in we mint a users row; on later sign-ins we echo the id.
 */
export const createOrUpdateUser = internalMutation({
  args: {
    provider: v.literal("anonymous"),
    providerAccountId: v.union(v.string(), v.null()),
    profile: v.any(),
    userId: v.union(v.string(), v.null()),
  },
  returns: v.id("users"),
  handler: async (ctx, args) => {
    if (args.userId !== null) {
      const existing = ctx.db.normalizeId("users", args.userId);
      if (existing === null) {
        throw new Error(`Unknown user id: ${args.userId}`);
      }
      return existing;
    }
    return await ctx.db.insert("users", {});
  },
});

/**
 * The currently signed-in user, or null. Demonstrates an authenticated query
 * that works both when preloaded on the server and live on the client.
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
    return { id: user._id };
  },
});
