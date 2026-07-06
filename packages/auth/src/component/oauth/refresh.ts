/**
 * `component.oauth.refresh.*` — OAuth 2.1 rotating refresh tokens (RFC 6749 §6),
 * grant/root model.
 *
 * A code exchange creates an `OAuthRefreshGrant` root (carrying the
 * client/user/scopes/resource) plus the first `OAuthRefreshToken` pointing at it.
 * `exchange` rotates single-use but tolerates the retries and concurrency real
 * clients exhibit; a replay *after* the chain has advanced past a token (its
 * child was consumed) and outside the grace window is theft and REVOKES THE
 * GRANT (`revokedAt`) in O(1). A revoked or missing grant makes every
 * one of its tokens fail closed at lookup, *before* the bounded, scheduled
 * `purgeRevokedGrant` cleanup deletes the token rows. Mirrors the session refresh
 * model (`token/refresh.ts` over `Session`).
 *
 * @module
 */

import { v } from "convex/values";

import { internal } from "../_generated/api";
import type { Id } from "../_generated/dataModel";
import type { MutationCtx } from "../_generated/server";
import { internalMutation, mutation, query } from "../functions";
import { vOAuthRefreshTokenDoc } from "../model";

/** Token rows deleted per `purgeRevokedGrant` transaction before it reschedules. */
const PURGE_MAX = 1000;

async function purgeGrantTokens(
  ctx: MutationCtx,
  grantId: Id<"OAuthRefreshGrant">,
): Promise<boolean> {
  const tokens = await ctx.db
    .query("OAuthRefreshToken")
    .withIndex("grant_id", (q) => q.eq("grantId", grantId))
    .take(PURGE_MAX + 1);
  for (const token of tokens.slice(0, PURGE_MAX)) {
    await ctx.db.delete("OAuthRefreshToken", token._id);
  }
  return tokens.length > PURGE_MAX;
}

/** Mark a grant revoked (O(1)) and schedule the bounded token-row cleanup. */
async function revokeGrant(
  ctx: MutationCtx,
  grantId: Id<"OAuthRefreshGrant">,
  revokedAt: number,
): Promise<void> {
  const grant = await ctx.db.get("OAuthRefreshGrant", grantId);
  if (grant === null) return;
  if (grant.revokedAt === undefined) {
    await ctx.db.patch("OAuthRefreshGrant", grantId, { revokedAt });
  }
  await ctx.scheduler.runAfter(0, internal.oauth.refresh.purgeRevokedGrant, { grantId });
}

/**
 * Continuation that drains a revoked/expired grant's token rows in bounded
 * batches, rescheduling until none remain and then deleting the grant row.
 * Leftover rows between batches are inert — `get`/`exchange` already reject a
 * revoked or missing grant.
 */
export const purgeRevokedGrant = internalMutation({
  args: { grantId: v.id("OAuthRefreshGrant") },
  returns: v.null(),
  handler: async (ctx, { grantId }) => {
    const hasMore = await purgeGrantTokens(ctx, grantId);
    if (hasMore) {
      await ctx.scheduler.runAfter(0, internal.oauth.refresh.purgeRevokedGrant, { grantId });
    } else {
      await ctx.db.delete("OAuthRefreshGrant", grantId);
    }
    return null;
  },
});

/**
 * Read a refresh token by its hash, failing closed when its grant is missing or
 * revoked (so a revoked grant's tokens are rejected before cleanup deletes them).
 */
export const get = query({
  args: { tokenHash: v.string() },
  returns: v.union(vOAuthRefreshTokenDoc, v.null()),
  handler: async (ctx, { tokenHash }) => {
    const doc = await ctx.db
      .query("OAuthRefreshToken")
      .withIndex("token_hash", (q) => q.eq("tokenHash", tokenHash))
      .first();
    if (doc === null || doc.grantId === undefined) return null;
    const grant = await ctx.db.get("OAuthRefreshGrant", doc.grantId);
    if (grant === null || grant.revokedAt !== undefined) return null;
    return doc;
  },
});

/** Create a refresh-token grant (root) and its first token. Returns the grant id. */
export const create = mutation({
  args: {
    tokenHash: v.string(),
    clientId: v.string(),
    userId: v.id("User"),
    scopes: v.array(v.string()),
    resource: v.optional(v.string()),
    expiresAt: v.number(),
  },
  returns: v.id("OAuthRefreshGrant"),
  handler: async (ctx, args) => {
    const grantId = await ctx.db.insert("OAuthRefreshGrant", {
      clientId: args.clientId,
      userId: args.userId,
      scopes: args.scopes,
      resource: args.resource,
      expiresAt: args.expiresAt,
    });
    await ctx.db.insert("OAuthRefreshToken", {
      tokenHash: args.tokenHash,
      grantId,
      expiresAt: args.expiresAt,
    });
    return grantId;
  },
});

const vExchangeResult = v.union(
  v.object({
    status: v.literal("rotated"),
    userId: v.id("User"),
    scopes: v.array(v.string()),
    resource: v.optional(v.string()),
  }),
  v.object({
    status: v.literal("reuse_detected"),
    userId: v.id("User"),
    clientId: v.string(),
  }),
  v.object({ status: v.literal("scope_exceeded") }),
  v.object({ status: v.literal("invalid") }),
);

/**
 * Rotate a refresh token, returning a `status`-tagged result.
 *
 * Rotation is single-use but tolerant of the retries and concurrency a real
 * client exhibits: a replay is `"rotated"` (benign) whenever the caller has not
 * provably rotated past the presented token — that token still has an unused
 * descendant tip — or the replay lands within `reuseWindowMs`. A benign replay
 * mints a fresh child and leaves existing tips valid (hash-only storage can't
 * re-hand the original child, so deleting it would strand a client that did
 * receive it, forcing a needless re-login). `"rotated"` carries the
 * user/scopes/resource for the next access token.
 *
 * `"reuse_detected"` is genuine theft: a token replayed *after* the chain
 * advanced past it (its child was already consumed) and outside the grace
 * window. The grant is revoked (`revokedAt`, O(1)) and its token rows scheduled
 * for bounded cleanup; the user/client are returned for audit. `"invalid"`
 * (unknown hash, missing/legacy grant, revoked grant, `clientId` mismatch, or
 * expired — the expired grant is revoked first) carries nothing; a `clientId`
 * mismatch does not revoke. `"scope_exceeded"` rejects a broadening request
 * without burning the token.
 */
export const exchange = mutation({
  args: {
    tokenHash: v.string(),
    newTokenHash: v.string(),
    clientId: v.string(),
    now: v.number(),
    newExpiresAt: v.number(),
    reuseWindowMs: v.number(),
    requestedScopes: v.optional(v.array(v.string())),
  },
  returns: vExchangeResult,
  handler: async (ctx, args) => {
    const doc = await ctx.db
      .query("OAuthRefreshToken")
      .withIndex("token_hash", (q) => q.eq("tokenHash", args.tokenHash))
      .first();
    if (doc === null || doc.grantId === undefined) return { status: "invalid" as const };
    const grantId = doc.grantId;
    const grant = await ctx.db.get("OAuthRefreshGrant", grantId);
    if (grant === null || grant.clientId !== args.clientId) return { status: "invalid" as const };
    if (grant.revokedAt !== undefined) return { status: "invalid" as const };

    if (doc.expiresAt < args.now || grant.expiresAt < args.now) {
      await revokeGrant(ctx, grantId, args.now);
      return { status: "invalid" as const };
    }

    // Reject a request for broader scope BEFORE rotating, so a bad scope request
    // doesn't advance (and burn) the client's refresh token.
    if (
      args.requestedScopes !== undefined &&
      args.requestedScopes.some((scope) => !grant.scopes.includes(scope))
    ) {
      return { status: "scope_exceeded" as const };
    }

    const issueChild = async () => {
      await ctx.db.insert("OAuthRefreshToken", {
        tokenHash: args.newTokenHash,
        grantId,
        expiresAt: args.newExpiresAt,
        parentTokenId: doc._id,
      });
      if (args.newExpiresAt > grant.expiresAt) {
        await ctx.db.patch("OAuthRefreshGrant", grantId, { expiresAt: args.newExpiresAt });
      }
    };
    const rotated = {
      status: "rotated" as const,
      userId: grant.userId,
      scopes: grant.scopes,
      resource: grant.resource,
    };

    if (doc.firstUsedTime === undefined) {
      await ctx.db.patch("OAuthRefreshToken", doc._id, { firstUsedTime: args.now });
      await issueChild();
      return rotated;
    }

    const unusedChild = await ctx.db
      .query("OAuthRefreshToken")
      .withIndex("grant_id_parent_token_id_first_used", (q) =>
        q.eq("grantId", grantId).eq("parentTokenId", doc._id).eq("firstUsedTime", undefined),
      )
      .first();
    if (unusedChild !== null || doc.firstUsedTime + args.reuseWindowMs > args.now) {
      await issueChild();
      return rotated;
    }

    await revokeGrant(ctx, grantId, args.now);
    return { status: "reuse_detected" as const, userId: grant.userId, clientId: grant.clientId };
  },
});

/**
 * Revoke a refresh token's whole grant (e.g. on sign-out): marks `revokedAt`
 * (O(1)) and schedules bounded token cleanup. Returns the `{ userId, clientId }`
 * of the revoked grant for audit, or `null` when no live token/grant matched.
 */
export const revoke = mutation({
  args: { tokenHash: v.string() },
  returns: v.union(v.object({ userId: v.id("User"), clientId: v.string() }), v.null()),
  handler: async (ctx, { tokenHash }) => {
    const doc = await ctx.db
      .query("OAuthRefreshToken")
      .withIndex("token_hash", (q) => q.eq("tokenHash", tokenHash))
      .first();
    if (doc === null || doc.grantId === undefined) return null;
    const grant = await ctx.db.get("OAuthRefreshGrant", doc.grantId);
    if (grant === null) return null;
    await revokeGrant(ctx, doc.grantId, Date.now());
    return { userId: grant.userId, clientId: grant.clientId };
  },
});
