import { v } from "convex/values";
import { mutation, MutationCtx, QueryCtx } from "./_generated/server";

/**
 * Creates or verifies an anonymous account in the `accounts` table.
 *
 * If no `args.id` value is present, creates a new anonymous account.
 *
 * Throws an error if `args.id` is present and doesn't match an existing
 * anonymous account.
 *
 * Returns the `anonymousId` stored in the table.
 */
export const signInAnonymous = mutation({
  args: { id: v.optional(v.string()) },
  handler: async (ctx, args) => {
    const returningId = args.id ?? null;
    if (returningId === null) {
      const anonymousId = crypto.randomUUID();
      await ctx.db.insert("accounts", { lastSignIn: Date.now(), anonymousId });
      return anonymousId;
    }
    const account = await getAccountByAnonymousId(ctx, returningId);
    if (!account) {
      throw Error("invalid id");
    }
    return returningId;
  },
});

async function getAccountByAnonymousId(
  ctx: QueryCtx | MutationCtx,
  id: string,
) {
  return await ctx.db
    .query("accounts")
    .withIndex("by_anonymousId", (q) => q.eq("anonymousId", id))
    .unique();
}
