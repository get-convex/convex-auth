/**
 * The app-owned callbacks the providers configured in `convex/auth.ts` call.
 *
 * A provider calls `createUser` the first time it sees an account, which creates the
 * app's user row and returns its id, and then calls the optional `onSignIn` on every
 * sign-in, that first one included.
 *
 * Both providers in this example share one pair of callbacks. The callbacks are
 * checked *contravariantly*, the way TypeScript checks an ordinary function
 * parameter: a mutation is accepted wherever it *accepts* what the provider
 * passes, so one that declares a union of provider names and a profile covering
 * both is valid for either provider. Declaring a narrower mutation per provider
 * (`provider: v.literal("password")`) works just as well, and is worth doing when
 * the two providers have little logic in common.
 *
 * The password provider includes the `username` in the profile data it supplies,
 * while the anonymous provider supplies an empty profile. In the app's data model,
 * the `username` is thus optional.
 *
 * @module
 */
import { getAuthUserId } from "@convex-dev/auth/core";
import { v } from "convex/values";
import { internalMutation, query } from "./_generated/server";

// The arguments both providers can be served by: either provider name, and a
// profile whose `username` is present only for password sign-ups.
const userCallbackArgs = {
  provider: v.union(v.literal("anonymous"), v.literal("password")),
  providerAccountId: v.string(),
  profile: v.object({ username: v.optional(v.string()) }),
};

export const createUser = internalMutation({
  args: userCallbackArgs,
  returns: v.id("users"),
  handler: async (ctx, args) => {
    return await ctx.db.insert("users", { username: args.profile.username });
  },
});

// An example of the per-sign-in hook. Here the app records a `lastSignedInAt`
// timestamp for each user on every sign-in, whichever provider they used.
export const onSignIn = internalMutation({
  args: { ...userCallbackArgs, userId: v.id("users") },
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
