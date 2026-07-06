/**
 * `component.token.refresh.*` — session refresh tokens.
 *
 * Reads collapse into one overloaded `get`;
 * `exchange` is a kept domain verb (rotation with replay detection).
 *
 * @module
 */

import { v } from "convex/values";

import { mutation, query } from "../functions";
import { vRefreshTokenDoc } from "../model";

/**
 * Upper bound on a session's RefreshToken rows deleted in one cleanup. The
 * session row is deleted first (so revocation is effective immediately); any
 * rows beyond this cap are inert — they reference a now-deleted session and are
 * reaped by the expiration cron — so a session with a pathologically large token
 * count can't make the cleanup exceed Convex read limits and roll back.
 */
const SESSION_TOKEN_DELETE_BATCH = 1024;

/**
 * Read a refresh token by `id`, or the session's currently-active (unused)
 * token via `activeForSession`. Accepts exactly one selector.
 */
export const get = query({
  args: {
    id: v.optional(v.id("RefreshToken")),
    activeForSession: v.optional(v.id("Session")),
  },
  returns: v.union(vRefreshTokenDoc, v.null()),
  handler: async (ctx, args) => {
    if (args.activeForSession !== undefined) {
      return await ctx.db
        .query("RefreshToken")
        .withIndex("session_id_first_used", (q) =>
          q.eq("sessionId", args.activeForSession!).eq("firstUsedTime", undefined),
        )
        .order("desc")
        .first();
    }
    if (args.id === undefined) return null;
    return await ctx.db.get("RefreshToken", args.id);
  },
});

/**
 * List up to `SESSION_TOKEN_DELETE_BATCH` refresh tokens for a session, or only
 * the children of `parentRefreshTokenId` when supplied.
 */
export const list = query({
  args: {
    sessionId: v.id("Session"),
    parentRefreshTokenId: v.optional(v.id("RefreshToken")),
  },
  returns: v.array(vRefreshTokenDoc),
  handler: async (ctx, { sessionId, parentRefreshTokenId }) => {
    if (parentRefreshTokenId !== undefined) {
      return await ctx.db
        .query("RefreshToken")
        .withIndex("session_id_parent_refresh_token_id", (q) =>
          q.eq("sessionId", sessionId).eq("parentRefreshTokenId", parentRefreshTokenId),
        )
        .take(SESSION_TOKEN_DELETE_BATCH);
    }
    return await ctx.db
      .query("RefreshToken")
      .withIndex("session_id", (q) => q.eq("sessionId", sessionId))
      .take(SESSION_TOKEN_DELETE_BATCH);
  },
});

/** Create a refresh token for a session. Returns the new id. */
export const create = mutation({
  args: {
    sessionId: v.id("Session"),
    expirationTime: v.number(),
    parentRefreshTokenId: v.optional(v.id("RefreshToken")),
  },
  returns: v.id("RefreshToken"),
  handler: async (ctx, args) => {
    return await ctx.db.insert("RefreshToken", args);
  },
});

/** Patch a refresh token in place. */
export const update = mutation({
  args: {
    id: v.id("RefreshToken"),
    patch: v.object({
      expirationTime: v.optional(v.number()),
      firstUsedTime: v.optional(v.number()),
    }),
  },
  returns: v.null(),
  handler: async (ctx, { id: refreshTokenId, patch }) => {
    await ctx.db.patch("RefreshToken", refreshTokenId, patch);
    return null;
  },
});

/** Delete all refresh tokens for a session. */
const remove = mutation({
  args: { sessionId: v.id("Session") },
  returns: v.null(),
  handler: async (ctx, { sessionId }) => {
    const tokens = await ctx.db
      .query("RefreshToken")
      .withIndex("session_id", (q) => q.eq("sessionId", sessionId))
      .take(SESSION_TOKEN_DELETE_BATCH);
    await Promise.all(tokens.map((token) => ctx.db.delete("RefreshToken", token._id)));
    return null;
  },
});

export { remove };

const refreshSessionExchangeResult = v.union(
  v.object({
    status: v.literal("rotated"),
    userId: v.id("User"),
    sessionId: v.id("Session"),
    refreshTokenId: v.id("RefreshToken"),
  }),
  v.object({
    status: v.literal("reuse_detected"),
    userId: v.id("User"),
    refreshTokenId: v.id("RefreshToken"),
  }),
  v.object({ status: v.literal("invalid") }),
);

/**
 * Rotate a refresh token, returning a `status`-tagged result. `"rotated"` (first
 * use, an in-window replay, or the already-issued active child) carries the
 * user/session/token ids for the next access token. `"reuse_detected"` (a replay
 * of an already-rotated token outside `reuseWindowMs`) is theft: the session and
 * all of its refresh tokens are deleted (forcing re-authentication) and the
 * user/token are returned so the server can audit it. `"invalid"` (a missing,
 * mismatched, or expired token, or a missing/expired session) carries nothing;
 * the session and its tokens are deleted in every such case except a token that
 * belongs to another session, which is left untouched.
 */
export const exchange = mutation({
  args: {
    refreshTokenId: v.id("RefreshToken"),
    sessionId: v.id("Session"),
    now: v.number(),
    refreshTokenExpirationTime: v.number(),
    reuseWindowMs: v.number(),
  },
  returns: refreshSessionExchangeResult,
  handler: async (ctx, args) => {
    const cleanupSessionArtifacts = async () => {
      const session = await ctx.db.get("Session", args.sessionId);
      if (session !== null) {
        await ctx.db.delete("Session", args.sessionId);
      }
      const tokens = await ctx.db
        .query("RefreshToken")
        .withIndex("session_id", (q) => q.eq("sessionId", args.sessionId))
        .take(SESSION_TOKEN_DELETE_BATCH);
      await Promise.all(tokens.map((token) => ctx.db.delete("RefreshToken", token._id)));
    };

    const refreshTokenDoc = await ctx.db.get("RefreshToken", args.refreshTokenId);
    if (refreshTokenDoc === null || refreshTokenDoc.sessionId !== args.sessionId) {
      return { status: "invalid" as const };
    }

    if (refreshTokenDoc.expirationTime < args.now) {
      await cleanupSessionArtifacts();
      return { status: "invalid" as const };
    }

    const session = await ctx.db.get("Session", args.sessionId);
    if (session === null || session.expirationTime < args.now) {
      await cleanupSessionArtifacts();
      return { status: "invalid" as const };
    }

    const issueRefreshToken = () =>
      ctx.db.insert("RefreshToken", {
        sessionId: args.sessionId,
        expirationTime: args.refreshTokenExpirationTime,
        parentRefreshTokenId: args.refreshTokenId,
      });

    if (refreshTokenDoc.firstUsedTime === undefined) {
      await ctx.db.patch("RefreshToken", args.refreshTokenId, {
        firstUsedTime: args.now,
      });
      const refreshTokenId = await issueRefreshToken();
      return {
        status: "rotated" as const,
        userId: session.userId,
        sessionId: args.sessionId,
        refreshTokenId,
      };
    }

    const activeRefreshToken = await ctx.db
      .query("RefreshToken")
      .withIndex("session_id_first_used", (q) =>
        q.eq("sessionId", args.sessionId).eq("firstUsedTime", undefined),
      )
      .order("desc")
      .first();

    if (
      activeRefreshToken !== null &&
      activeRefreshToken.parentRefreshTokenId === args.refreshTokenId
    ) {
      return {
        status: "rotated" as const,
        userId: session.userId,
        sessionId: args.sessionId,
        refreshTokenId: activeRefreshToken._id,
      };
    }

    if (refreshTokenDoc.firstUsedTime + args.reuseWindowMs > args.now) {
      const refreshTokenId = await issueRefreshToken();
      return {
        status: "rotated" as const,
        userId: session.userId,
        sessionId: args.sessionId,
        refreshTokenId,
      };
    }

    const reuseUserId = session.userId;
    await cleanupSessionArtifacts();
    return {
      status: "reuse_detected" as const,
      userId: reuseUserId,
      refreshTokenId: args.refreshTokenId,
    };
  },
});
