import { internalMutation } from "./_generated/server";
import { v } from "convex/values";

export const upsertFromAuth = internalMutation({
  args: {
    provider: v.union(v.literal("anonymous")),
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
      default: {
        const _exhaustive: never = args.provider;
        return _exhaustive;
      }
    }
  },
});
