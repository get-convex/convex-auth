import type { Doc, Id } from "./_generated/dataModel";
import type { MutationCtx, QueryCtx } from "./_generated/server";
import type { AccountLink } from "../../lib/tokens.js";

/**
 * Data-access helpers for the core's own tables. These are plain functions, not
 * registered Convex functions: functions in `public.ts` run inside a single
 * transaction, so they call these directly rather than hopping through
 * `ctx.runQuery` / `ctx.runMutation` (which would fragment one logical
 * operation into several sub-transactions). The app's user-creation callback is
 * the one exception: it lives in the app, so it must be reached via a function
 * handle.
 */

export async function getAccount(
  ctx: QueryCtx,
  provider: string,
  providerAccountId: string,
): Promise<Doc<"accounts"> | null> {
  return await ctx.db
    .query("accounts")
    .withIndex("by_provider_account", (q) =>
      q.eq("provider", provider).eq("providerAccountId", providerAccountId),
    )
    .unique();
}

export async function createAccount(
  ctx: MutationCtx,
  args: {
    provider: string;
    providerAccountId: string;
    userId: string;
    profile: unknown;
  },
): Promise<Doc<"accounts">> {
  const id = await ctx.db.insert("accounts", {
    provider: args.provider,
    providerAccountId: args.providerAccountId,
    userId: args.userId,
    profile: args.profile,
  });
  return (await ctx.db.get(id))!;
}

export async function updateAccountProfile(
  ctx: MutationCtx,
  accountId: Id<"accounts">,
  profile: unknown,
): Promise<void> {
  await ctx.db.patch(accountId, { profile });
}

/**
 * Link a provider identity to an existing app user. Unlike sign-in, this never
 * creates a user. The caller supplies the `userId` to attach the identity to
 * (e.g. adding another identity to an existing user).
 *
 * Idempotent: if the identity is already linked to `userId`, the profile is
 * refreshed and `linked: false` is returned. Linking an identity that already
 * belongs to a *different* user is rejected.
 */
export async function linkAccount(
  ctx: MutationCtx,
  args: {
    provider: string;
    providerAccountId: string;
    userId: string;
    profile: unknown;
  },
): Promise<AccountLink> {
  const existing = await getAccount(ctx, args.provider, args.providerAccountId);
  if (existing) {
    if (existing.userId !== args.userId) {
      throw new Error("This identity is already linked to a different user.");
    }
    await ctx.db.patch(existing._id, { profile: args.profile });
    return { linked: false, userId: existing.userId };
  }
  await ctx.db.insert("accounts", {
    provider: args.provider,
    providerAccountId: args.providerAccountId,
    userId: args.userId,
    profile: args.profile,
  });
  return { linked: true, userId: args.userId };
}

// ---------------------------------------------------------------------------
// Sessions (refresh tokens)
// ---------------------------------------------------------------------------

export async function createSession(
  ctx: MutationCtx,
  args: {
    userId: string;
    accountId: Id<"accounts">;
    refreshTokenHash: string;
    refreshTokenExpiresAt: number;
  },
): Promise<Id<"sessions">> {
  return await ctx.db.insert("sessions", {
    userId: args.userId,
    accountId: args.accountId,
    refreshTokenHash: args.refreshTokenHash,
    refreshTokenExpiresAt: args.refreshTokenExpiresAt,
    lastRefreshedAt: Date.now(),
  });
}

export async function getSessionByHash(
  ctx: QueryCtx,
  refreshTokenHash: string,
): Promise<Doc<"sessions"> | null> {
  return await ctx.db
    .query("sessions")
    .withIndex("by_refresh_hash", (q) =>
      q.eq("refreshTokenHash", refreshTokenHash),
    )
    .unique();
}

/**
 * Look up a session by its *previous* (just-rotated) refresh-token hash. Used
 * by `refresh` to honor the rotation grace window when a slightly-stale token
 * is presented. Refresh tokens are unique, so at most one session matches.
 */
export async function getSessionByPreviousHash(
  ctx: QueryCtx,
  refreshTokenHash: string,
): Promise<Doc<"sessions"> | null> {
  return await ctx.db
    .query("sessions")
    .withIndex("by_previous_refresh_hash", (q) =>
      q.eq("previousRefreshTokenHash", refreshTokenHash),
    )
    .unique();
}

/**
 * Rotate a session's refresh token. The hash being replaced is retained as the
 * `previous*` pair with a short grace expiry so a concurrent refresh presenting
 * it still resolves (see the schema note).
 */
export async function rotateSession(
  ctx: MutationCtx,
  args: {
    sessionId: Id<"sessions">;
    refreshTokenHash: string;
    refreshTokenExpiresAt: number;
    previousRefreshTokenHash: string;
    previousRefreshTokenExpiresAt: number;
  },
): Promise<void> {
  await ctx.db.patch(args.sessionId, {
    refreshTokenHash: args.refreshTokenHash,
    refreshTokenExpiresAt: args.refreshTokenExpiresAt,
    previousRefreshTokenHash: args.previousRefreshTokenHash,
    previousRefreshTokenExpiresAt: args.previousRefreshTokenExpiresAt,
    lastRefreshedAt: Date.now(),
  });
}

export async function deleteSessionByHash(
  ctx: MutationCtx,
  refreshTokenHash: string,
): Promise<boolean> {
  const session = await getSessionByHash(ctx, refreshTokenHash);
  if (session) await ctx.db.delete(session._id);
  return session !== null;
}
