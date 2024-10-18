import { Infer, v } from "convex/values";
import { ActionCtx, MutationCtx } from "../types.js";
import * as Provider from "../provider.js";
import { logWithLevel, maybeRedact } from "../utils.js";
import {
  deleteAllRefreshTokens,
  invalidateRefreshTokensInSubtree,
  loadActiveRefreshToken,
  parseRefreshToken,
  REFRESH_TOKEN_REUSE_WINDOW_MS,
  refreshTokenIfValid,
} from "../refreshTokens.js";
import { generateTokensForSession } from "../sessions.js";

export const refreshSessionArgs = v.object({
  refreshToken: v.string(),
});

type ReturnType = null | {
  token: string;
  refreshToken: string;
};

export async function refreshSessionImpl(
  ctx: MutationCtx,
  args: Infer<typeof refreshSessionArgs>,
  getProviderOrThrow: Provider.GetProviderOrThrowFunc,
  config: Provider.Config,
): Promise<ReturnType> {
  const { refreshToken } = args;
  const { refreshTokenId, sessionId: tokenSessionId } =
    parseRefreshToken(refreshToken);
  logWithLevel(
    "DEBUG",
    `refreshSessionImpl args: Token ID: ${maybeRedact(refreshTokenId)} Session ID: ${maybeRedact(
      tokenSessionId,
    )}`,
  );
  const validationResult = await refreshTokenIfValid(
    ctx,
    refreshTokenId,
    tokenSessionId,
  );

  if (validationResult === null) {
    // Replicating `deleteSession` but ensuring that we delete both the session
    // and the refresh token, even if one of them is missing.
    const session = await ctx.db.get(tokenSessionId);
    if (session !== null) {
      await ctx.db.delete(session._id);
    }
    await deleteAllRefreshTokens(ctx, tokenSessionId);
    return null;
  }
  const { session } = validationResult;
  const sessionId = session._id;
  const userId = session.userId;

  const tokenFirstUsed = validationResult.refreshTokenDoc.firstUsedTime;

  // First use -- mark as used and generate new refresh token
  if (tokenFirstUsed === undefined) {
    await ctx.db.patch(refreshTokenId, {
      firstUsedTime: Date.now(),
    });
    const result = await generateTokensForSession(ctx, config, {
      userId,
      sessionId,
      issuedRefreshTokenId: null,
      parentRefreshTokenId: refreshTokenId,
    });
    const { refreshTokenId: newRefreshTokenId } = parseRefreshToken(
      result.refreshToken,
    );
    logWithLevel(
      "DEBUG",
      `Exchanged ${maybeRedact(validationResult.refreshTokenDoc._id)} (first use) for new refresh token ${maybeRedact(newRefreshTokenId)}`,
    );
    return result;
  }

  // Token has been used before
  // Check if parent of active refresh token
  const activeRefreshToken = await loadActiveRefreshToken(ctx, tokenSessionId);
  logWithLevel(
    "DEBUG",
    `Active refresh token: ${maybeRedact(activeRefreshToken?._id ?? "(none)")}, parent ${maybeRedact(activeRefreshToken?.parentRefreshTokenId ?? "(none)")}`,
  );
  if (
    activeRefreshToken !== null &&
    activeRefreshToken.parentRefreshTokenId === refreshTokenId
  ) {
    logWithLevel(
      "DEBUG",
      `Token ${maybeRedact(validationResult.refreshTokenDoc._id)} is parent of active refresh token ${maybeRedact(activeRefreshToken._id)}, so returning that token`,
    );

    const result = await generateTokensForSession(ctx, config, {
      userId,
      sessionId,
      issuedRefreshTokenId: activeRefreshToken._id,
      parentRefreshTokenId: refreshTokenId,
    });
    return result;
  }

  // Check if within reuse window
  if (tokenFirstUsed + REFRESH_TOKEN_REUSE_WINDOW_MS > Date.now()) {
    const result = await generateTokensForSession(ctx, config, {
      userId,
      sessionId,
      issuedRefreshTokenId: null,
      parentRefreshTokenId: refreshTokenId,
    });
    const { refreshTokenId: newRefreshTokenId } = parseRefreshToken(
      result.refreshToken,
    );
    logWithLevel(
      "DEBUG",
      `Exchanged ${maybeRedact(validationResult.refreshTokenDoc._id)} (reuse) for new refresh token ${maybeRedact(newRefreshTokenId)}`,
    );
    return result;
  } else {
    // Outside of reuse window -- invalidate all refresh tokens in subtree
    logWithLevel("ERROR", "Refresh token used outside of reuse window");
    logWithLevel(
      "DEBUG",
      `Token ${maybeRedact(validationResult.refreshTokenDoc._id)} being used outside of reuse window, so invalidating all refresh tokens in subtree`,
    );
    const tokensToInvalidate = await invalidateRefreshTokensInSubtree(
      ctx,
      validationResult.refreshTokenDoc,
    );
    logWithLevel(
      "DEBUG",
      `Invalidated ${tokensToInvalidate.length} refresh tokens in subtree: ${tokensToInvalidate
        .map((token) => maybeRedact(token._id))
        .join(", ")}`,
    );
    return null;
  }
}

export const callRefreshSession = async (
  ctx: ActionCtx,
  args: Infer<typeof refreshSessionArgs>,
): Promise<ReturnType> => {
  return ctx.runMutation("auth:store" as any, {
    args: {
      type: "refreshSession",
      ...args,
    },
  });
};
