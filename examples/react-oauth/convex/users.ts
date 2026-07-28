import { internalMutation, query } from "./_generated/server";
import { v } from "convex/values";
import { vGoogleProfile } from "@convex-dev/auth/providers/oauth/google";
import { vGithubProfile } from "@convex-dev/auth/providers/oauth/github";

/**
 * The signed-in user's document, or `null` when unauthenticated. The JWT's
 * subject is the app user id minted by `createOrUpdateUser`.
 */
export const me = query({
  args: {},
  returns: v.union(
    v.null(),
    v.object({
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
    const user = await ctx.db.get("users", userId);
    if (user === null) {
      return null;
    }
    return { email: user.email };
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
    provider: v.union(v.literal("google"), v.literal("github")),
    providerAccountId: v.string(),
    profile: v.union(vGoogleProfile, vGithubProfile),
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
