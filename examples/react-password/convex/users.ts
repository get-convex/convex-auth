import { internalMutation } from "./_generated/server";
import { passwordUserCallbackArgs } from "@convex-dev/auth/providers/password/setup";
import { v } from "convex/values";

/**
 * Create the user row for a new password account and return its id. This
 * example keeps no data in the row, but your app can put a profile here.
 *
 * `passwordUserCallbackArgs` declares the `provider`, `providerAccountId` and
 * `profile` args the provider sends. Destructure them in the handler when your
 * app wants them (for example, to store `profile.username` on the row).
 */
export const createUser = internalMutation({
  args: passwordUserCallbackArgs,
  returns: v.id("users"),
  handler: async (ctx) => {
    return await ctx.db.insert("users", {});
  },
});
