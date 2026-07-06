/**
 * `component.session.*` — auth sessions.
 *
 * `issue` is a kept domain verb (token issuance).
 *
 * @module
 */

import { v } from "convex/values";

import { mutation, query } from "./functions";
import { vSessionDoc } from "./model";

const SESSION_TOKEN_DELETE_BATCH = 1024;

/** Read a session by id. */
export const get = query({
  args: { id: v.id("Session") },
  returns: v.union(vSessionDoc, v.null()),
  handler: async (ctx, { id: sessionId }) => {
    return await ctx.db.get("Session", sessionId);
  },
});

/** List the sessions owned by a user. */
export const list = query({
  args: { userId: v.id("User") },
  returns: v.array(vSessionDoc),
  handler: async (ctx, { userId }) => {
    return await ctx.db
      .query("Session")
      .withIndex("user_id", (q) => q.eq("userId", userId))
      .take(REVOKE_FOR_USER_MAX);
  },
});

/**
 * Create (or rotate) a session together with its first refresh token.
 * Returns the resolved `{ userId, sessionId, refreshTokenId }` — a command
 * summary rather than `v.null()` — because callers need the freshly minted
 * ids to mint tokens and set cookies. When a `replaceSessionId` session was
 * present and deleted, its id is echoed back as `replacedSessionId` so the
 * caller can emit a `session.invalidated` audit event for the terminated
 * session.
 */
export const create = mutation({
  args: {
    userId: v.id("User"),
    sessionId: v.optional(v.id("Session")),
    replaceSessionId: v.optional(v.id("Session")),
    sessionExpirationTime: v.number(),
    refreshTokenExpirationTime: v.optional(v.number()),
  },
  returns: v.object({
    userId: v.id("User"),
    sessionId: v.id("Session"),
    refreshTokenId: v.optional(v.id("RefreshToken")),
    replacedSessionId: v.optional(v.id("Session")),
  }),
  handler: async (ctx, args) => {
    let sessionId = args.sessionId;
    let replacedSessionId: typeof args.replaceSessionId;

    if (sessionId === undefined) {
      if (args.replaceSessionId !== undefined) {
        const existingSession = await ctx.db.get("Session", args.replaceSessionId);
        if (existingSession !== null) {
          await ctx.db.delete("Session", args.replaceSessionId);
          replacedSessionId = args.replaceSessionId;
        }

        const existingTokens = await ctx.db
          .query("RefreshToken")
          .withIndex("session_id", (q) => q.eq("sessionId", args.replaceSessionId!))
          .take(SESSION_TOKEN_DELETE_BATCH);
        await Promise.all(existingTokens.map((token) => ctx.db.delete("RefreshToken", token._id)));
      }

      sessionId = await ctx.db.insert("Session", {
        userId: args.userId,
        expirationTime: args.sessionExpirationTime,
      });
    }

    const refreshTokenId =
      args.refreshTokenExpirationTime === undefined
        ? undefined
        : await ctx.db.insert("RefreshToken", {
            sessionId: sessionId,
            expirationTime: args.refreshTokenExpirationTime,
          });

    return {
      userId: args.userId,
      sessionId,
      ...(refreshTokenId === undefined ? {} : { refreshTokenId }),
      ...(replacedSessionId === undefined ? {} : { replacedSessionId }),
    };
  },
});

/** Delete a session (no-op if it no longer exists). */
const remove = mutation({
  args: { id: v.id("Session") },
  returns: v.null(),
  handler: async (ctx, { id: sessionId }) => {
    if ((await ctx.db.get("Session", sessionId)) !== null) {
      await ctx.db.delete("Session", sessionId);
    }
    return null;
  },
});

export { remove };

/** Upper bound on sessions revoked in one de-provisioning transaction. */
const REVOKE_FOR_USER_MAX = 1000;

/**
 * Revoke every session a user owns, deleting each session and all of its
 * refresh tokens in one atomic transaction. Used on SSO de-provisioning so an
 * offboarded user's live session cookie and long-lived refresh token stop
 * working immediately rather than at natural expiry. Bounded at
 * {@link REVOKE_FOR_USER_MAX} sessions per call; returns the number revoked.
 */
export const revokeForUser = mutation({
  args: { userId: v.id("User") },
  returns: v.object({ revoked: v.number() }),
  handler: async (ctx, { userId }) => {
    const sessions = await ctx.db
      .query("Session")
      .withIndex("user_id", (q) => q.eq("userId", userId))
      .take(REVOKE_FOR_USER_MAX);
    for (const session of sessions) {
      const tokens = await ctx.db
        .query("RefreshToken")
        .withIndex("session_id", (q) => q.eq("sessionId", session._id))
        .take(SESSION_TOKEN_DELETE_BATCH);
      for (const token of tokens) {
        await ctx.db.delete("RefreshToken", token._id);
      }
      await ctx.db.delete("Session", session._id);
    }
    return { revoked: sessions.length };
  },
});
