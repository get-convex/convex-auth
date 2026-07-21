/**
 * `component.oauth.refresh.*` — OAuth 2.1 rotating refresh tokens (RFC 6749 §6),
 * grant/root model.
 *
 * A code exchange creates an `OAuthRefreshGrant` root (carrying the
 * client/user/scopes/resource) plus the first `OAuthRefreshToken` pointing at it.
 * `exchange` rotates single-use: a used token yields EXACTLY ONE child (never a
 * fork), tolerating a client's immediate retry of the same rotation within a
 * grace window by re-pointing that single child. A replay once the chain has
 * advanced past a token (its child was consumed), or a distinct rotation of an
 * already-used token outside the window, is theft and REVOKES THE GRANT
 * (`revokedAt`) in O(1). A revoked or missing grant makes every one of its tokens
 * fail closed at lookup, *before* the bounded, scheduled `purgeRevokedGrant`
 * cleanup deletes the token rows. Mirrors the session refresh model
 * (`token/refresh.ts` over `Session`).
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

/**
 * Upper bound on the still-unused successor rows dropped when re-pointing a
 * token's single child on an in-window retry. Post-fix a token has exactly one
 * unused successor; the cap only ever matters when draining a legacy fork left by
 * an older build, keeping the mutation within Convex read/write limits.
 */
const REPLACE_MAX = 64;

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
 * Rotation is single-use and a used token yields EXACTLY ONE child — it never
 * forks a second, independent chain (the flaw that let a one-time-stolen token
 * ride its own fork undetected). Tolerance for the retries a real client exhibits
 * is bounded and cannot fork:
 *
 * - First use marks the presented token used and mints its one child.
 * - Re-presenting the SAME rotation (identical `newTokenHash`) is idempotent.
 * - Within `reuseWindowMs`, re-presenting the token with a *different*
 *   `newTokenHash` (a dropped/slow response the client retried) RE-POINTS the
 *   single child to the freshly presented token: the prior unused tip is dropped,
 *   so exactly one successor ever exists. A client that only received the earlier
 *   tip fails its next rotation and re-authenticates rather than forking.
 *
 * `"rotated"` carries the user/scopes/resource for the next access token.
 *
 * `"reuse_detected"` is theft: the token is replayed either *after* the chain
 * advanced past it (its child was already consumed) or, having never advanced,
 * with a distinct successor *outside* the grace window. Both revoke the grant
 * (`revokedAt`, O(1)) and schedule bounded token cleanup; the user/client are
 * returned for audit. `"invalid"` (unknown hash, missing/legacy grant, revoked
 * grant, `clientId` mismatch, or expired — the expired grant is revoked first)
 * carries nothing; a `clientId` mismatch does not revoke. `"scope_exceeded"`
 * rejects a broadening request without burning the token.
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

    const mintChild = async () => {
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
    const reuse = {
      status: "reuse_detected" as const,
      userId: grant.userId,
      clientId: grant.clientId,
    };

    // First rotation: mark the presented token used and mint its single child.
    if (doc.firstUsedTime === undefined) {
      await ctx.db.patch("OAuthRefreshToken", doc._id, { firstUsedTime: args.now });
      await mintChild();
      return rotated;
    }

    // The presented token was already rotated once, so it must yield EXACTLY ONE
    // child — it never forks a second, independent chain.

    // Idempotent retry of the SAME rotation (identical `newTokenHash`, e.g. a
    // mutation/OCC retry): the presented token's still-unused successor is already
    // registered with exactly this hash, so there is nothing to do.
    const alreadyIssued = await ctx.db
      .query("OAuthRefreshToken")
      .withIndex("token_hash", (q) => q.eq("tokenHash", args.newTokenHash))
      .first();
    if (
      alreadyIssued !== null &&
      alreadyIssued.grantId === grantId &&
      alreadyIssued.parentTokenId === doc._id &&
      alreadyIssued.firstUsedTime === undefined
    ) {
      return rotated;
    }

    // The presented token's still-unused successor(s). Post-fix there is at most
    // one; the bounded take also drains any legacy fork left by an older build.
    const unusedChildren = await ctx.db
      .query("OAuthRefreshToken")
      .withIndex("grant_id_parent_token_id_first_used", (q) =>
        q.eq("grantId", grantId).eq("parentTokenId", doc._id).eq("firstUsedTime", undefined),
      )
      .take(REPLACE_MAX);

    if (unusedChildren.length === 0) {
      // The successor was already consumed — the chain provably advanced past the
      // presented token, so replaying it is theft. Revoke the whole grant family.
      await revokeGrant(ctx, grantId, args.now);
      return reuse;
    }

    if (doc.firstUsedTime + args.reuseWindowMs > args.now) {
      // Within the grace window: a benign retry of the same rotation whose response
      // was dropped/slow. Re-point the single successor to the freshly presented
      // token WITHOUT forking — drop the prior unused successor(s), then mint the
      // new one. A client that only ever saw an earlier tip fails its next rotation
      // and re-authenticates; it can never ride a second chain.
      for (const child of unusedChildren) {
        await ctx.db.delete("OAuthRefreshToken", child._id);
      }
      await mintChild();
      return rotated;
    }

    // A distinct rotation of an already-used token outside the grace window, whose
    // successor was never advanced: treat as reuse and revoke the family.
    await revokeGrant(ctx, grantId, args.now);
    return reuse;
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
