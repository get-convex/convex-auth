/**
 * Each provider configured in `convex/auth.ts` has app-owned callbacks defined here.
 *
 * A provider calls `createUser` the first time it sees an account, which creates the
 * app's user row and returns its id, and then calls the optional `onSignIn` on every
 * sign-in, that first one included. Each callback has a signature that matches the
 * associated provider and the data that it supplies.
 *
 * In this example, the username and password provider includes the `username` in the
 * profile data that it provides, while the anonymous provider doesn't. In the app's
 * data model, the `username` is thus optional.
 *
 * @module
 */
import { getAuthUserId } from "@convex-dev/auth/core";
import { v } from "convex/values";
import { internalMutation, query } from "./_generated/server";

export const createUserAnonymous = internalMutation({
  args: {
    provider: v.literal("anonymous"),
    providerAccountId: v.string(),
    profile: v.object({}),
  },
  returns: v.id("users"),
  handler: async (ctx) => {
    return await ctx.db.insert("users", {});
  },
});

export const createUserPassword = internalMutation({
  args: {
    provider: v.literal("password"),
    providerAccountId: v.string(),
    profile: v.object({ username: v.string() }),
  },
  returns: v.id("users"),
  handler: async (ctx, args) => {
    return await ctx.db.insert("users", { username: args.profile.username });
  },
});

// Below is an exmple of using the per-sign-in hooks. Here the app is choosing to
// record a `lastSignedInAt` timestamp for each user upon sign-in.

export const onSignInAnonymous = internalMutation({
  args: {
    provider: v.literal("anonymous"),
    providerAccountId: v.string(),
    profile: v.object({}),
    userId: v.id("users"),
  },
  returns: v.null(),
  handler: async (ctx, args) => {
    await ctx.db.patch("users", args.userId, { lastSignedInAt: Date.now() });
  },
});

export const onSignInPassword = internalMutation({
  args: {
    provider: v.literal("password"),
    providerAccountId: v.string(),
    profile: v.object({ username: v.string() }),
    userId: v.id("users"),
  },
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
