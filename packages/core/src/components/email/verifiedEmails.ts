import { mutation, query } from "./_generated/server.ts";
import { Infer, v } from "convex/values";
import { sha256Hex } from "../../lib/crypto.ts";
import { emailsByUserId, emailByNormalizedEmail } from "./helpers.ts";
import { addEmailUserError, normalizeEmail } from "./validation.ts";

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

const addEmailResult = v.union(
  v.object({
    success: v.literal(true),
    userId: v.string(),
    email: v.string(),
    isPrimary: v.boolean(),
    // With `setPrimary`: the address that was primary before this call
    // replaced it, or `null` when there was none. Callers use it to notify
    // the old address.
    previousPrimaryEmail: v.union(v.string(), v.null()),
  }),
  v.object({ success: v.literal(false), userError: addEmailUserError }),
);
type AddEmailResult = Infer<typeof addEmailResult>;

/**
 * Record a verified email address for a user, by spending the proof that
 * `challenge.complete` returned.
 *
 * The proof is the only way to add an address: there is no argument for the
 * address or the user, both come from the completed challenge. A proof is
 * one-shot; the challenge row is deleted here. Call this in the same
 * mutation as `challenge.complete`.
 *
 * - `setPrimary: false`: add the address; it becomes primary only when the
 *   user has no address yet.
 * - `setPrimary: true`: the address becomes primary and the previous primary
 *   address (if any) is removed from the account. Use this in apps where a
 *   user has a single address.
 *
 * TODO: add a component function to change the primary address.
 *
 * Throws when the challenge was started without a `userId`: such a proof
 * only attests ownership of the address and has no user to record it for.
 */
export const add = mutation({
  args: { proof: v.string(), setPrimary: v.boolean() },
  returns: addEmailResult,
  handler: async (ctx, args): Promise<AddEmailResult> => {
    const proofHash = await sha256Hex(args.proof);
    const row = await ctx.db
      .query("challenges")
      .withIndex("by_proofHash", (q) => q.eq("proofHash", proofHash))
      .unique();
    if (row === null) {
      return { success: false, userError: { error: "INVALID_PROOF" } };
    }
    // One-shot: the proof is spent whatever happens next.
    await ctx.db.delete("challenges", row._id);
    if (row.expiresAt < Date.now()) {
      return { success: false, userError: { error: "INVALID_PROOF" } };
    }
    if (row.userId === undefined) {
      throw new Error(
        "verifiedEmails.add needs a challenge that was started with a " +
          "userId. This proof only attests ownership of the address.",
      );
    }
    const userId = row.userId;
    const normalizedEmail = normalizeEmail(row.email);

    // The address must still be free: another user may have verified it
    // after this challenge started.
    if ((await emailByNormalizedEmail(ctx, normalizedEmail)) !== null) {
      return { success: false, userError: { error: "EMAIL_TAKEN" } };
    }

    let previousPrimaryEmail: string | null = null;
    let isPrimary: boolean;
    if (args.setPrimary) {
      const oldPrimary = await ctx.db
        .query("verifiedEmails")
        .withIndex("by_userId_isPrimary", (q) =>
          q.eq("userId", userId).eq("isPrimary", true),
        )
        .unique();
      if (oldPrimary !== null) {
        previousPrimaryEmail = oldPrimary.email;
        await ctx.db.delete("verifiedEmails", oldPrimary._id);
      }
      isPrimary = true;
    } else {
      // The first address of a user always becomes primary.
      isPrimary = (await emailsByUserId(ctx, userId)).length === 0;
    }
    await ctx.db.insert("verifiedEmails", {
      email: row.email,
      normalizedEmail,
      userId,
      isPrimary,
      source: { kind: "self" },
    });
    return {
      success: true,
      userId,
      email: row.email,
      isPrimary,
      previousPrimaryEmail,
    };
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
      .withIndex("by_userId", (q) => q.eq("userId", userId))
      .collect();
    for (const row of challenges) {
      await ctx.db.delete("challenges", row._id);
    }
    return null;
  },
});
