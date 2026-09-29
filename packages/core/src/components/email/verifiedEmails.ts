import { mutation, query } from "./_generated/server.ts";
import { v } from "convex/values";
import {
  emailsByUserId,
  emailByNormalizedEmail,
  getClientIp,
  rateLimiter,
} from "./helpers.ts";
import {
  lookupEmailResult,
  normalizeEmail,
  type LookupEmailResult,
} from "./validation.ts";

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
 * Get the primary email address of a user.
 *
 * The function returns `null` when the user has no verified email.
 */
export const getPrimaryEmail = query({
  args: { userId: v.string() },
  returns: v.union(v.string(), v.null()),
  handler: async (ctx, { userId }): Promise<string | null> => {
    const row = await ctx.db
      .query("verifiedEmails")
      .withIndex("by_userId_isPrimary", (q) =>
        q.eq("userId", userId).eq("isPrimary", true),
      )
      .unique();
    return row === null ? null : row.email;
  },
});

/**
 * Find the user that a verified email address identifies.
 *
 * Call this function when the address comes from a person who is not signed
 * in, for example at sign-in or at the start of a password recovery. Each
 * call takes a token from a per-IP limit before the lookup, so that a client
 * cannot probe many addresses to find which ones have an account. The
 * function returns `RATE_LIMITED` when the client IP has no token.
 *
 * The lookup ignores the case and the Unicode normalization form of the
 * `email` argument. The `storedEmail` field of the result is the address as
 * the user verified it, which can be different from the argument in case or
 * in Unicode form. It is the address that matched, not the primary address
 * of the user.
 *
 * The function returns an `EMAIL_NOT_FOUND` error when no user has verified
 * this address.
 */
export const lookupEmail = mutation({
  args: { email: v.string() },
  returns: lookupEmailResult,
  handler: async (ctx, { email }): Promise<LookupEmailResult> => {
    const limit = await rateLimiter.limit(ctx, "lookupEmailPerIp", {
      key: await getClientIp(ctx),
    });
    if (!limit.ok) {
      return {
        success: false,
        userError: { error: "RATE_LIMITED", retryAfterMs: limit.retryAfter },
      };
    }
    const row = await emailByNormalizedEmail(ctx, normalizeEmail(email));
    if (row === null) {
      return { success: false, userError: { error: "EMAIL_NOT_FOUND" } };
    }
    return { success: true, userId: row.userId, storedEmail: row.email };
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
