import { internalMutation, query } from "./_generated/server";
import { Id } from "./_generated/dataModel";
import { v } from "convex/values";

/**
 * The app's user create-or-update callback. The core invokes it (via a function
 * handle) on every sign-in — without a `userId` the first time an identity is
 * seen, and with the resolved `userId` thereafter.
 */
export const upsertFromAuth = internalMutation({
  args: {
    provider: v.union(v.literal("anonymous")),
    providerAccountId: v.string(),
    profile: v.any(),
    userId: v.union(v.string(), v.null()),
  },
  returns: v.id("users"),
  handler: async (ctx, args) => {
    switch (args.provider) {
      case "anonymous": {
        const name = "Anonymous";
        return ctx.db.insert("users", { name });
      }
      default: {
        const _exhaustive: never = args.provider;
        return _exhaustive;
      }
    }
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

    return { id: user._id, name: user.name };
  },
});
