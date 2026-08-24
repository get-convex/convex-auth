import type { Auth } from "convex/server";
import type { GenericId } from "convex/values";

/**
 * The ID of the user the caller is signed in as, or `null` when the caller is
 * not signed in.
 *
 * ```ts
 * import { getAuthUserId } from "@convex-dev/auth/core";
 *
 * export const loggedInUser = query({
 *   args: {},
 *   handler: async (ctx) => {
 *     const userId = await getAuthUserId(ctx);
 *     if (userId === null) {
 *       return null;
 *     }
 *     return await ctx.db.get("users", userId);
 *   },
 * });
 * ```
 */
export async function getAuthUserId(ctx: {
  auth: Auth;
}): Promise<GenericId<"users"> | null> {
  // TODO(nicolas) This should validate the session

  const identity = await ctx.auth.getUserIdentity();
  if (identity === null) {
    return null;
  }
  return identity.subject as GenericId<"users">;
}
