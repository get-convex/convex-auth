import { internalMutation } from "./_generated/server";
import { v } from "convex/values";

/**
 * The app's user create-or-update callback. The core invokes it (via a function
 * handle) on every sign-in — without a `userId` the first time an identity is
 * seen, and with the resolved `userId` thereafter.
 */
export const upsertFromAuth = internalMutation({
  args: {
    // TODO: dowski - remove this when we have real providers to work with
    provider: v.union(v.literal("fake")),
    providerAccountId: v.string(),
    profile: v.any(),
    userId: v.union(v.string(), v.null()),
  },
  returns: v.id("users"),
  handler: async (ctx, args) => {
    if (args.profile.name && typeof args.profile.name === "string") {
      return ctx.db.insert("users", { name: args.profile.name });
    }
    throw Error("unable to add user; no name");
  },
});
