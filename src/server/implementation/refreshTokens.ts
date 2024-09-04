import { GenericId } from "convex/values";
import { ConvexAuthConfig } from "../index.js";
import { MutationCtx } from "./types.js";
import {
  LOG_LEVELS,
  REFRESH_TOKEN_DIVIDER,
  logWithLevel,
  stringToNumber,
} from "./utils.js";

const DEFAULT_SESSION_INACTIVE_DURATION_MS = 1000 * 60 * 60 * 24 * 30; // 30 days

export async function createRefreshToken(
  ctx: MutationCtx,
  sessionId: GenericId<"authSessions">,
  config: ConvexAuthConfig,
) {
  const expirationTime =
    Date.now() +
    (config.session?.inactiveDurationMs ??
      stringToNumber(process.env.AUTH_SESSION_INACTIVE_DURATION_MS) ??
      DEFAULT_SESSION_INACTIVE_DURATION_MS);
  const newRefreshTokenId = await ctx.db.insert("authRefreshTokens", {
    sessionId,
    expirationTime,
  });
  return `${newRefreshTokenId}${REFRESH_TOKEN_DIVIDER}${sessionId}`;
}

export async function deleteRefreshTokens(
  ctx: MutationCtx,
  sessionId: GenericId<"authSessions">,
) {
  const existingRefreshTokens = await ctx.db
    .query("authRefreshTokens")
    .withIndex("sessionId", (q) => q.eq("sessionId", sessionId))
    .collect();
  for (const refreshTokenDoc of existingRefreshTokens) {
    await ctx.db.delete(refreshTokenDoc._id);
  }
}

export async function validateRefreshToken(
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
