import { internalMutation } from "./_generated/server";
import { v } from "convex/values";

/**
 * The app's create-or-update-user callback for the email flow. It is invoked in
 * three situations:
 *
 *  - At sign-up (`createUser`): `userId` is null and the profile is empty. We
 *    insert a bare users row with *no* email — the address isn't proven yet.
 *  - At confirmation (`completeSignIn` with `existingUserId`): `userId` is set to
 *    the row we created at sign-up. We echo it back. The email itself is written
 *    directly by the provider's `confirmEmail` (which also enforces uniqueness),
 *    so we don't set it here.
 *  - At sign-in: `userId` is the resolved account's user; we echo it.
 */
export const createOrUpdateUser = internalMutation({
  args: {
    provider: v.literal("password"),
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
    // First sign-up: create a bare row with no email (unproven address).
    return await ctx.db.insert("users", {});
  },
});
