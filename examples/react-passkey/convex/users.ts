import { internalMutation } from "./_generated/server";
import { Id } from "./_generated/dataModel";
import { v } from "convex/values";

/**
 * The app's user callback for Convex Auth. The passkey provider calls it
 * with three shapes (see the `UsernamePasskey` documentation):
 *
 * 1. No arguments: create a new empty user row and return its id. The
 *    provider makes this call before the WebAuthn ceremony, because the
 *    row id is the WebAuthn user handle.
 * 2. `userId: null` with `profile.existingUserId`: the first sign-in of a
 *    new account. Return the row from shape 1 instead of a new row. The
 *    value is trusted: it comes from the provider, not from the client.
 * 3. `userId` set: a returning sign-in or a username change. Update the
 *    stored username and return the same id.
 */
export const createOrUpdateUser = internalMutation({
  args: {
    provider: v.optional(v.literal("passkey")),
    providerAccountId: v.optional(v.string()),
    profile: v.optional(v.any()),
    userId: v.optional(v.union(v.string(), v.null())),
  },
  returns: v.id("users"),
  handler: async (ctx, args) => {
    // Shape 1: a call with no arguments creates an empty user row.
    if (args.provider === undefined && args.userId === undefined) {
      return await ctx.db.insert("users", {});
    }

    const username =
      typeof args.profile?.username === "string"
        ? args.profile.username
        : undefined;

    const applyUsername = async (id: Id<"users">) => {
      if (username !== undefined) {
        await ctx.db.patch("users", id, { username });
      }
      return id;
    };

    // Shape 3: a returning user. Update the username from the profile.
    if (typeof args.userId === "string") {
      const existing = ctx.db.normalizeId("users", args.userId);
      if (existing === null) {
        throw new Error(`Unknown user id: ${args.userId}`);
      }
      return await applyUsername(existing);
    }

    // Shape 2: the first sign-in of a new account. The provider created
    // the user row earlier and put its id into the profile.
    const existingUserId =
      typeof args.profile?.existingUserId === "string"
        ? args.profile.existingUserId
        : undefined;
    if (existingUserId !== undefined) {
      const existing = ctx.db.normalizeId("users", existingUserId);
      if (existing === null) {
        throw new Error(`Unknown user id: ${existingUserId}`);
      }
      return await applyUsername(existing);
    }

    // A first sign-in without an earlier user row. The passkey provider
    // does not use this path, but a second provider could.
    return await ctx.db.insert("users", { username });
  },
});
