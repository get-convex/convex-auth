import { Doc, MutationCtx } from "../types.js";
import { normalizeEmail } from "../utils.js";

/**
 * Look up an auth account by provider and account ID.
 *
 * Tries an exact match first, then falls back to a normalized (lowercased)
 * lookup. This makes reads backward-compatible: accounts created before
 * email normalization was introduced are still reachable by their original
 * casing, while new (normalized) accounts are found on the fallback query.
 */
export async function findAccountByProviderAndId(
  ctx: MutationCtx,
  provider: string,
  providerAccountId: string,
): Promise<Doc<"authAccounts"> | null> {
  const exact = await ctx.db
    .query("authAccounts")
    .withIndex("providerAndAccountId", (q) =>
      q.eq("provider", provider).eq("providerAccountId", providerAccountId),
    )
    .unique();
  if (exact !== null) return exact;

  const normalized = normalizeEmail(providerAccountId);
  if (normalized === providerAccountId) return null;

  return await ctx.db
    .query("authAccounts")
    .withIndex("providerAndAccountId", (q) =>
      q.eq("provider", provider).eq("providerAccountId", normalized),
    )
    .unique();
}
