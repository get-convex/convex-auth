import { mutation, query, QueryCtx } from "./_generated/server";
import { Doc } from "./_generated/dataModel";
import { v } from "convex/values";
import { normalizeEmail } from "./validation";

/**
 * Get the verified email addresses of a user.
 *
 * The function returns an empty array when the user has no verified email.
 */
export const getEmails = query({
  args: { userId: v.string() },
  returns: v.array(v.object({ email: v.string(), isPrimary: v.boolean() })),
  handler: async (
    ctx,
    { userId },
  ): Promise<{ email: string; isPrimary: boolean }[]> => {
    const rows = await emailsByUserId(ctx, userId);
    return rows.map((row) => ({ email: row.email, isPrimary: row.isPrimary }));
  },
});

/**
 * Find the user that a verified email address identifies.
 *
 * The lookup ignores the case and the Unicode normalization form of the
 * `email` argument. The function returns `null` when no user has verified
 * this address.
 */
export const getUserIdByEmail = query({
  args: { email: v.string() },
  returns: v.union(v.string(), v.null()),
  handler: async (ctx, { email }): Promise<string | null> => {
    const row = await emailByNormalizedEmail(ctx, normalizeEmail(email));
    return row === null ? null : row.userId;
  },
});

/**
 * Delete all data the component holds for a user.
 *
 * Call this when the app deletes the user. The function is idempotent.
 */
export const deleteUser = mutation({
  args: { userId: v.string() },
  returns: v.null(),
  handler: async (ctx, { userId }): Promise<null> => {
    const rows = await emailsByUserId(ctx, userId);
    for (const row of rows) {
      await ctx.db.delete("emails", row._id);
    }
    return null;
  },
});

function emailsByUserId(
  ctx: QueryCtx,
  userId: string,
): Promise<Doc<"emails">[]> {
  return ctx.db
    .query("emails")
    .withIndex("by_userId", (q) => q.eq("userId", userId))
    .collect();
}

function emailByNormalizedEmail(
  ctx: QueryCtx,
  email: string,
): Promise<Doc<"emails"> | null> {
  return ctx.db
    .query("emails")
    .withIndex("by_email", (q) => q.eq("email", email))
    .unique();
}
