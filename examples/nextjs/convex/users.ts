/**
 * Each provider configured in `convex/auth.ts` has app-owned callbacks defined here.
 *
 * A provider calls `onSignUp` the first time it sees an account, which creates the
 * app's user row and returns its id, and the optional `onSignIn` whenever a known
 * account signs back in. Each callback has a signature that matches the associated
 * provider and the data that it supplies.
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

export const onSignUpAnonymous = internalMutation({
  args: {
    provider: v.literal("anonymous"),
    providerAccountId: v.string(),
    profile: v.object({}),
  },
  returns: v.id("users"),
  handler: async (ctx) => {
    return await createUser(ctx, {});
  },
});

export const onSignUpPassword = internalMutation({
  args: {
    provider: v.literal("password"),
    providerAccountId: v.string(),
    profile: v.object({ username: v.string() }),
  },
  returns: v.id("users"),
  handler: async (ctx, args) => {
    return await createUser(ctx, { username: args.profile.username });
  },
});

/**
 * The return-visit hook for the password provider. The user already exists, so
 * there is nothing to return, just a chance to touch the app's own record.
 *
 * The anonymous provider has no equivalent: every anonymous sign-in establishes
 * a new account, so it only takes an `onSignUp`.
 */
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
    return null;
  },
});

/**
 * The shared body of this app's sign-up callbacks. Providers that supply a
 * username pass it along; the anonymous one has none.
 */
async function createUser(
  ctx: MutationCtx,
  args: { username?: string },
): Promise<Id<"users">> {
  return await ctx.db.insert("users", {
    username: args.username,
    lastSignedInAt: Date.now(),
  });
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
