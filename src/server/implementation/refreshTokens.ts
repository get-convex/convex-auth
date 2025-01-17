import { GenericId } from "convex/values";
import { ConvexAuthConfig } from "../index.js";
import { Doc, MutationCtx, QueryCtx } from "./types.js";
import {
  LOG_LEVELS,
  REFRESH_TOKEN_DIVIDER,
  logWithLevel,
  maybeRedact,
  stringToNumber,
} from "./utils.js";

const DEFAULT_SESSION_INACTIVE_DURATION_MS = 1000 * 60 * 60 * 24 * 30; // 30 days
export const REFRESH_TOKEN_REUSE_WINDOW_MS = 10 * 1000; // 10 seconds
export async function createRefreshToken(
  ctx: MutationCtx,
  config: ConvexAuthConfig,
  sessionId: GenericId<"authSessions">,
  parentRefreshTokenId: GenericId<"authRefreshTokens"> | null,
) {
  const expirationTime =
    Date.now() +
    (config.session?.inactiveDurationMs ??
      stringToNumber(process.env.AUTH_SESSION_INACTIVE_DURATION_MS) ??
      DEFAULT_SESSION_INACTIVE_DURATION_MS);
  const newRefreshTokenId = await ctx.db.insert("authRefreshTokens", {
    sessionId,
    expirationTime,
    parentRefreshTokenId: parentRefreshTokenId ?? undefined,
  });
  return newRefreshTokenId;
}

export const formatRefreshToken = (
  refreshTokenId: GenericId<"authRefreshTokens">,
  sessionId: GenericId<"authSessions">,
) => {
  return `${refreshTokenId}${REFRESH_TOKEN_DIVIDER}${sessionId}`;
};

export const parseRefreshToken = (
  refreshToken: string,
): {
  refreshTokenId: GenericId<"authRefreshTokens">;
  sessionId: GenericId<"authSessions">;
} => {
  const [refreshTokenId, sessionId] = refreshToken.split(REFRESH_TOKEN_DIVIDER);
  if (!refreshTokenId || !sessionId) {
    throw new Error(`Can't parse refresh token: ${maybeRedact(refreshToken)}`);
  }
  return {
    refreshTokenId: refreshTokenId as GenericId<"authRefreshTokens">,
    sessionId: sessionId as GenericId<"authSessions">,
  };
};

/**
 * Mark all refresh tokens descending from the given refresh token as invalid immediately.
 * This is used when we detect an invalid use of a refresh token, and want to revoke
 * the entire tree.
 *
 * @param ctx
 * @param refreshToken
 */
export async function invalidateRefreshTokensInSubtree(
  ctx: MutationCtx,
  refreshToken: Doc<"authRefreshTokens">,
) {
  const tokensToInvalidate = [refreshToken];
  let frontier = [refreshToken._id];
  while (frontier.length > 0) {
    const nextFrontier = [];
    for (const currentTokenId of frontier) {
      const children = await ctx.db
        .query("authRefreshTokens")
        .withIndex("sessionIdAndParentRefreshTokenId", (q) =>
          q
            .eq("sessionId", refreshToken.sessionId)
            .eq("parentRefreshTokenId", currentTokenId),
        )
        .collect();
      tokensToInvalidate.push(...children);
      nextFrontier.push(...children.map((child) => child._id));
    }
    frontier = nextFrontier;
  }
  for (const token of tokensToInvalidate) {
    // Mark these as used so they can't be used again (even within the reuse window)
    if (
      token.firstUsedTime === undefined ||
      token.firstUsedTime > Date.now() - REFRESH_TOKEN_REUSE_WINDOW_MS
    ) {
      await ctx.db.patch(token._id, {
        firstUsedTime: Date.now() - REFRESH_TOKEN_REUSE_WINDOW_MS,
      });
    }
  }
  return tokensToInvalidate;
}

export async function deleteAllRefreshTokens(
  ctx: MutationCtx,
  sessionId: GenericId<"authSessions">,
) {
  const existingRefreshTokens = await ctx.db
    .query("authRefreshTokens")
    .withIndex("sessionIdAndParentRefreshTokenId", (q) =>
      q.eq("sessionId", sessionId),
    )
    .collect();
  for (const refreshTokenDoc of existingRefreshTokens) {
    await ctx.db.delete(refreshTokenDoc._id);
  }
}

export async function refreshTokenIfValid(
  ctx: MutationCtx,
  refreshTokenId: string,
  tokenSessionId: string,
) {
  const refreshTokenDoc = await ctx.db.get(
    refreshTokenId as GenericId<"authRefreshTokens">,
  );

  if (refreshTokenDoc === null) {
    logWithLevel(LOG_LEVELS.ERROR, "Invalid refresh token");
    return null;
  }
  if (refreshTokenDoc.expirationTime < Date.now()) {
    logWithLevel(LOG_LEVELS.ERROR, "Expired refresh token");
    return null;
  }
  if (refreshTokenDoc.sessionId !== tokenSessionId) {
    logWithLevel(LOG_LEVELS.ERROR, "Invalid refresh token session ID");
    return null;
  }
  const session = await ctx.db.get(refreshTokenDoc.sessionId);
  if (session === null) {
    logWithLevel(LOG_LEVELS.ERROR, "Invalid refresh token session");
    return null;
  }
  if (session.expirationTime < Date.now()) {
    logWithLevel(LOG_LEVELS.ERROR, "Expired refresh token session");
    return null;
  }
  return { session, refreshTokenDoc };
}
/**
 * The active refresh token is the most recently created refresh token that has
 * never been used.
 *
 * @param ctx
 * @param sessionId
 */
export async function loadActiveRefreshToken(
  ctx: QueryCtx,
  sessionId: GenericId<"authSessions">,
) {
  return ctx.db
    .query("authRefreshTokens")
    .withIndex("sessionId", (q) => q.eq("sessionId", sessionId))
    .filter((q) => q.eq(q.field("firstUsedTime"), undefined))
    .order("desc")
    .first();
}
