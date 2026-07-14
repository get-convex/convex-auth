import { internalMutation, query } from "./_generated/server";
import { Id } from "./_generated/dataModel";
import { v } from "convex/values";

/**
 * The app's create-or-update-user callback (see `attachUserCallback`). The core
 * invokes it on every sign-in — without a `userId` the first time an identity is
 * seen, and with the resolved `userId` thereafter. On the first sign-in we mint
 * a users row from the profile's username; on later sign-ins we echo the id.
 */
export const createOrUpdateUser = internalMutation({
  args: {
    provider: v.literal("password"),
    providerAccountId: v.string(),
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
    const username =
      typeof args.profile?.username === "string"
        ? args.profile.username
        : undefined;
    return await ctx.db.insert("users", { username });
  },
});

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

    return { id: user._id, username: user.username };
  },
});
