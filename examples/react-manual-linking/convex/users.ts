import { internalMutation } from "./_generated/server";
import { v } from "convex/values";

export const upsertFromAuth = internalMutation({
  args: {
    provider: v.union(v.literal("anonymous"), v.literal("password")),
    providerAccountId: v.string(),
    profile: v.any(),
    userId: v.union(v.string(), v.null()),
  },
  returns: v.id("users"),
  handler: async (ctx, args) => {
    switch (args.provider) {
      case "anonymous": {
        return ctx.db.insert("users", {});
      }
      case "password": {
        const username =
          typeof args.profile?.username === "string"
            ? args.profile.username
            : undefined;
        // A non-null userId is a returning sign-in or, for a user that
        // started out anonymous, a newly linked password account.
        if (args.userId !== null) {
          const userId = ctx.db.normalizeId("users", args.userId);
          if (userId === null) {
            throw new Error(`Unknown user id: ${args.userId}`);
          }
          await ctx.db.patch("users", userId, { username });
          return userId;
        }
        return ctx.db.insert("users", { username });
      }
      default: {
        const _exhaustive: never = args.provider;
        return _exhaustive;
      }
    }
  },
});
