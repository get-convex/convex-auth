/**
 * The app-owned callbacks the providers configured in `convex/auth.ts` call.
 *
 * A provider calls `createUser` the first time it sees an account, which creates the
 * app's user row and returns its id, and then calls the optional `onSignIn` on every
 * sign-in, that first one included.
 *
 * Both providers in this example share one pair of callbacks. The password
 * provider includes the `username` in the profile data it supplies, while the
 * anonymous provider supplies an empty profile. In the app's data model, the
 * `username` is thus optional.
 *
 * @module
 */
import { getAuthUserId } from "@convex-dev/auth/core";
import { v } from "convex/values";
import { internalMutation, query } from "./_generated/server";

// The union shape of the configured providers.
const vProvider = v.union(
  v.object({
    name: v.literal("anonymous"),
    accountId: v.string(),
    profile: v.object({}),
  }),
  v.object({
    name: v.literal("password"),
    accountId: v.string(),
    profile: v.object({ username: v.string() }),
  }),
);

export const createUser = internalMutation({
  args: { provider: vProvider },
  returns: v.id("users"),
  handler: async (ctx, args) => {
    return await ctx.db.insert("users", {
      username:
        args.provider.name === "password"
          ? args.provider.profile.username
          : undefined,
    });
  },
});

// An example of the per-sign-in hook. Here the app records a `lastSignedInAt`
// timestamp for each user on every sign-in, whichever provider they used.
export const onSignIn = internalMutation({
  args: { provider: vProvider, userId: v.id("users") },
  returns: v.null(),
  handler: async (ctx, args) => {
    await ctx.db.patch("users", args.userId, { lastSignedInAt: Date.now() });
  },
});

/**
 * The currently signed-in user, or null. Demonstrates an authenticated query
 * that works both when preloaded on the server and live on the client.
 */
export const loggedInUser = query({
  args: {},
  handler: async (ctx) => {
    const userId = await getAuthUserId(ctx);
    if (userId === null) {
      return null;
    }
    const user = await ctx.db.get("users", userId);
    if (user === null) {
      return null;
    }
    return { id: user._id, username: user.username ?? null };
  },
});
