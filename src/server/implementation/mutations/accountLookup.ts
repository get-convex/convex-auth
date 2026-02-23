import { Doc, MutationCtx } from "../types.js";
import { normalizeEmail } from "../utils.js";

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
