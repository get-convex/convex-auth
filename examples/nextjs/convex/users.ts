/**
 * The app-owned user callbacks the providers in `convex/auth.ts` are wired to.
 *
 * A provider calls `createUser` the first time it sees an account, which creates
 * the app's user row and returns its id, and then calls the optional `onSignIn`
 * on every sign-in, that first one included.
 *
 * Both providers here share one pair of callbacks. A provider does not demand a
 * callback declaring its own name and profile exactly; it only demands one that
 * *accepts* what it calls the callback with. So args declared wide enough to
 * cover several providers — a union of provider names, a profile with the
 * fields any of them may send — satisfy all of them at once, and the handler
 * sorts out which provider it is dealing with.
 *
 * In this example the username and password provider puts a `username` in the
 * profile it supplies while the anonymous provider supplies nothing, so the
 * shared `profile` makes `username` optional, as does the app's own data model.
 *
 * @module
 */
import { v } from "convex/values";
import { Id } from "./_generated/dataModel";
import { internalMutation, query } from "./_generated/server";

/** The providers wired up in `convex/auth.ts`. */
const provider = v.union(v.literal("anonymous"), v.literal("password"));

/**
 * What either provider may tell us about the user: the password provider sends
 * a username, the anonymous one sends an empty profile.
 */
const profile = v.object({ username: v.optional(v.string()) });

export const createUser = internalMutation({
  args: { provider, providerAccountId: v.string(), profile },
  returns: v.id("users"),
  handler: async (ctx, args) => {
    return await ctx.db.insert("users", { username: args.profile.username });
  },
});

/**
 * The per-sign-in hook. Because `onSignIn` runs on a first sign-in too, right
 * after `createUser`, stamping `lastSignedInAt` here covers every sign-in and
 * `createUser` doesn't have to repeat it.
 */
export const onSignIn = internalMutation({
  args: {
    provider,
    providerAccountId: v.string(),
    profile,
    userId: v.id("users"),
  },
  returns: v.null(),
  handler: async (ctx, args) => {
    await ctx.db.patch("users", args.userId, { lastSignedInAt: Date.now() });
    return null;
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
    return { id: user._id, username: user.username ?? null };
  },
});
