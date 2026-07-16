import { internalMutation, query } from "./_generated/server";
import { v } from "convex/values";

/**
 * The signed-in user's document, or `null` when unauthenticated. The JWT's
 * subject is the app user id minted by `createOrUpdateUser`.
 */
export const me = query({
  args: {},
  returns: v.union(
    v.null(),
    v.object({
      _id: v.id("users"),
      _creationTime: v.number(),
      email: v.string(),
    }),
  ),
  handler: async (ctx) => {
    const identity = await ctx.auth.getUserIdentity();
    if (identity === null) {
      return null;
    }
    const userId = ctx.db.normalizeId("users", identity.subject);
    if (userId === null) {
      return null;
    }
    return await ctx.db.get("users", userId);
  },
});

/**
 * The app's create-or-update-user callback (see `attachUserCallback`). The core
 * invokes it on every sign-in — without a `userId` the first time an identity is
 * seen, and with the resolved `userId` thereafter. On the first sign-in we mint
 * a users row from the profile's username; on later sign-ins we echo the id.
 */
export const createOrUpdateUser = internalMutation({
  args: {
    provider: v.literal("google"),
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
    const email = args.profile?.email;
    if (email === undefined) {
      throw new Error("Profile email is required");
    }
    return await ctx.db.insert("users", { email });
  },
});
