import { QueryCtx } from "./_generated/server.ts";
import { Doc } from "./_generated/dataModel.ts";

// --- Configuration ---------------------------------------------------------

/**
 * How long a `custom` link stays valid when the caller gives no `ttlMs`, and
 * the bounds for the value that a caller can give. The default is short: a
 * custom flow can give access to an account (OWASP ASVS v5 6.5.5 asks for at
 * most 10 minutes for password resets). The maximum keeps the table from
 * holding links for days.
 * TODO(nicolas): review the default and the bounds.
 */
export const CUSTOM_TTL_DEFAULT_MS = 15 * 60 * 1000; // 15 minutes
export const CUSTOM_TTL_MIN_MS = 60 * 1000; // 1 minute
export const CUSTOM_TTL_MAX_MS = 24 * 60 * 60 * 1000; // 24 hours

// --- Shared helpers --------------------------------------------------------

export function emailsByUserId(
  ctx: QueryCtx,
  userId: string,
): Promise<Doc<"verifiedEmails">[]> {
  return ctx.db
    .query("verifiedEmails")
    .withIndex("by_userId", (q) => q.eq("userId", userId))
    .collect();
}

export function emailByNormalizedEmail(
  ctx: QueryCtx,
  normalizedEmail: string,
): Promise<Doc<"verifiedEmails"> | null> {
  return ctx.db
    .query("verifiedEmails")
    .withIndex("by_normalizedEmail", (q) =>
      q.eq("normalizedEmail", normalizedEmail),
    )
    .unique();
}
