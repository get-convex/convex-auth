import type { Auth } from "convex/server";
import type { GenericId } from "convex/values";

/**
 * The ID of the user the caller is signed in as, or `null` when the caller is
 * not signed in.
 *
 * ```ts
 * import { getAuthUserId } from "@convex-dev/auth/server";
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
 *
 * The id is typed as one in the `"users"` table. If the app's users live in a
 * table with another name (see `convexAuth`'s `usersTable` option), name it
 * here too:
 *
 * ```ts
 * const userId = await getAuthUserId<"members">(ctx);
 * ```
 */
export async function getAuthUserId<UsersTable extends string = "users">(ctx: {
  auth: Auth;
}): Promise<GenericId<UsersTable> | null> {
  // TODO(nicolas) This should validate the session

  const identity = await ctx.auth.getUserIdentity();
  if (identity === null) {
    return null;
  }
  return identity.subject as GenericId<UsersTable>;
}
