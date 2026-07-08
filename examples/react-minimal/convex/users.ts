import { internalMutation, query } from "./_generated/server";
import { Id } from "./_generated/dataModel";
import { v } from "convex/values";

/**
 * The app's user create-or-update callback. The core invokes it (via a function
 * handle) on every sign-in — without a `userId` the first time an identity is
 * seen, and with the resolved `userId` thereafter.
 */
export const upsertFromAuth = internalMutation({
  args: {
    provider: v.union(v.literal("anonymous")),
    providerAccountId: v.string(),
    profile: v.any(),
    userId: v.union(v.string(), v.null()),
  },
  returns: v.id("users"),
  handler: async (ctx, args) => {
    if (args.userId) {
      // We don't do any updating for existing users. Simply return
      // the ID back.
      return args.userId as Id<"users">;
    }
    switch (args.provider) {
      case "anonymous": {
        const name = "Anonymous";
        const anonymousAccountId = args.providerAccountId;
        return ctx.db.insert("users", { name, anonymousAccountId });
      }
      default: {
        const _exhaustive: never = args.provider;
        return _exhaustive;
      }
    }
  },
});

/**
 * Returns an anonymous sign in ID for an authenticated user, if one exists.
 */
export const anonymousSignInId = query({
  args: {},
  handler: async (ctx) => {
    const ident = await ctx.auth.getUserIdentity();
    if (!ident) {
      return null;
    }
    return (await ctx.db.get("users", ident.subject as Id<"users">))
      ?.anonymousAccountId;
  },
});
