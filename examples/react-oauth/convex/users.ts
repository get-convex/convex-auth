import { ConvexError, v } from "convex/values";
import { internalMutation, MutationCtx, query } from "./_generated/server";
import { vGoogleProfile } from "@convex-dev/auth/providers/oauth/google";
import { vGithubProfile } from "@convex-dev/auth/providers/oauth/github";

export const getCurrentUser = query({
  args: {},
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
    return { verifiedEmail: user.verifiedEmail };
  },
});

export const createUserGoogle = internalMutation({
  args: {
    provider: v.literal("google"),
    providerAccountId: v.string(),
    profile: vGoogleProfile,
  },
  handler: async (ctx, args) => {
    return await createUser(ctx, {
      email: args.profile.email,
      emailVerified: args.profile.emailVerified,
    });
  },
});

export const createUserGithub = internalMutation({
  args: {
    provider: v.literal("github"),
    providerAccountId: v.string(),
    profile: vGithubProfile,
  },
  handler: async (ctx, args) => {
    return await createUser(ctx, {
      email: args.profile.email,
      emailVerified: args.profile.emailVerified,
    });
  },
});

async function createUser(
  ctx: MutationCtx,
  args: { email?: string; emailVerified: boolean },
) {
  const { email, emailVerified } = args;
  if (email === undefined) {
    throw new ConvexError("No email provided");
  }
  // Linking accounts is technically not supported, but you can do it manually
  // if you choose. For this example we consider GitHub and Google's email
  // verification status to be sufficient to link two accounts based on email.
  if (!emailVerified) {
    throw new ConvexError("Email not verified with provider");
  }
  const existingUser = await ctx.db
    .query("users")
    .withIndex("verifiedEmail", (q) => q.eq("verifiedEmail", email))
    .unique();
  if (existingUser !== null) {
    return existingUser._id;
  }
  return await ctx.db.insert("users", { verifiedEmail: email });
}
