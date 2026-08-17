/**
 * Each provider configured in `convex/auth.ts` has an app-owned callback defined here.
 *
 * The callback is inovked whenever a user signs in. Each callback has a signature that
 * matches the associated provider and the data that it supplies.
 *
 * In this example, the username and password provider includes the `username` in the
 * profile data that it provides, while the anonymous provider doesn't. In the app's
 * data model, the `username` is thus optional.
 *
 * @module
 */
import { v } from "convex/values";
import { Id } from "./_generated/dataModel";
import { internalMutation, MutationCtx, query } from "./_generated/server";

export const createOrUpdateUserAnonymous = internalMutation({
  args: {
    provider: v.literal("anonymous"),
    providerAccountId: v.string(),
    profile: v.object({}),
    userId: v.union(v.id("users"), v.null()),
  },
  returns: v.id("users"),
  handler: async (ctx, args) => {
    return await createOrUpdateUser(ctx, { userId: args.userId });
  },
});

export const createOrUpdateUserPassword = internalMutation({
  args: {
    provider: v.literal("password"),
    providerAccountId: v.string(),
    profile: v.object({ username: v.string() }),
    userId: v.union(v.id("users"), v.null()),
  },
  returns: v.id("users"),
  handler: async (ctx, args) => {
    return await createOrUpdateUser(ctx, {
      userId: args.userId,
      username: args.profile.username,
    });
  },
});

/**
 * The shared body of this app's create-or-update-user callbacks.
 *
 * The core invokes one of them on every sign-in — without a `userId` the first
 * time an identity is seen, and with the resolved `userId` thereafter. On the
 * first sign-in we mint a users row (with the username, when the provider
 * supplies one); on later sign-ins we echo the id.
 */
async function createOrUpdateUser(
  ctx: MutationCtx,
  args: { userId: Id<"users"> | null; username?: string },
): Promise<Id<"users">> {
  if (args.userId !== null) {
    return args.userId;
  }
  return await ctx.db.insert("users", { username: args.username });
}

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
    return { id: user._id, username: user.username ?? null };
  },
});
