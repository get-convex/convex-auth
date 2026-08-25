import { mutation, query } from "./_generated/server.ts";
import { v } from "convex/values";
import { emailsByUserId, emailByNormalizedEmail } from "./helpers.ts";
import { normalizeEmail } from "./validation.ts";

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
 * `email` argument. The `email` field of the result is the stored address,
 * with the case that the user gave, which can be different from the argument.
 * The function returns `null` when no user has verified this address.
 */
export const getUserIdByEmail = query({
  args: { email: v.string() },
  returns: v.union(
    v.object({ userId: v.string(), email: v.string() }),
    v.null(),
  ),
  handler: async (
    ctx,
    { email },
  ): Promise<{ userId: string; email: string } | null> => {
    const row = await emailByNormalizedEmail(ctx, normalizeEmail(email));
    return row === null ? null : { userId: row.userId, email: row.email };
  },
});

/**
 * Delete all data the component holds for a user: verified emails and
 * pending challenges.
 *
 * Call this when the app deletes the user. The function is idempotent.
 */
export const deleteUser = mutation({
  args: { userId: v.string() },
  returns: v.null(),
  handler: async (ctx, { userId }): Promise<null> => {
    const rows = await emailsByUserId(ctx, userId);
    for (const row of rows) {
      await ctx.db.delete("verifiedEmails", row._id);
    }
    const challenges = await ctx.db
      .query("challenges")
      .withIndex("by_purpose_userId", (q) => q.eq("purpose.userId", userId))
      .collect();
    for (const row of challenges) {
      await ctx.db.delete("challenges", row._id);
    }
    return null;
  },
});
