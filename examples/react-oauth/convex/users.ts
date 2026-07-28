import { internalMutation, query } from "./_generated/server";
import { ConvexError, v } from "convex/values";
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
 * seen (this is the one moment the identity→user association is decided), and
 * with the resolved `userId` thereafter.
 *
 * First sign-ins link by verified email: an identity whose email already
 * belongs to a user attaches to that user, otherwise a new user is minted — so
 * signing in with Google and GitHub under one email yields one user, and email
 * stays unique. Sign-ins without a verified email are rejected outright,
 * including GitHub accounts with no verified email: this example ships no
 * email-verification flow, so an unverified row would be an unrecoverable dead
 * end that blocks the email's verified owner from signing in. The thrown
 * `ConvexError` copy surfaces in the sign-in card through the client's
 * `flowError` (code `"rejected"`). A real app with a
 * verification mechanism can instead allow unverified sign-ups (keeping the
 * verified flag on the user row) and refuse, or require verification, only when
 * an email collides.
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
      // Repeat sign-in: the identity already resolves to this user. Profile
      // changes (e.g. an email changed at the provider) are not synced — that
      // needs an update policy plus a collision rule against the unique email
      // index, out of scope for a reference example.
      const existing = ctx.db.normalizeId("users", args.userId);
      if (existing === null) {
        throw new Error(`Unknown user id: ${args.userId}`);
      }
      return existing;
    }
    const { email, emailVerified } = args.profile;
    if (email === undefined || !emailVerified) {
      throw new ConvexError("A verified email is required to sign in");
    }
    const existingUser = await ctx.db
      .query("users")
      .withIndex("email", (q) => q.eq("email", email))
      .unique();
    if (existingUser !== null) {
      return existingUser._id;
    }
    return await ctx.db.insert("users", { email });
  },
});
