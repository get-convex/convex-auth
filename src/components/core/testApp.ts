import { internalMutation } from "./_generated/server";
import { v } from "convex/values";

/**
 * Stand-in for the app's user-creation callback, used only by the core's
 * isolated test suite. The core invokes this (by function handle) the first
 * time a new account signs in; like a minimal real app, it owns no users table
 * and just echoes the provider-scoped account id back as the app user id,
 * honoring an explicit `userId` when one is supplied (the link path).
 *
 * Excluded from the published build — it exists purely to give the convex-test
 * deployment a concrete `createUser` mutation to resolve the handle against.
 */
export const createUser = internalMutation({
  args: {
    provider: v.string(),
    providerAccountId: v.string(),
    profile: v.any(),
    userId: v.optional(v.string()),
  },
  returns: v.string(),
  handler: async (_ctx, args) => args.userId ?? args.providerAccountId,
});
