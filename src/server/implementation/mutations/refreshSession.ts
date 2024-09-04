import { GenericId, Infer, v } from "convex/values";
import { ActionCtx, MutationCtx } from "../types.js";
import * as Provider from "../provider.js";
import { REFRESH_TOKEN_DIVIDER, logWithLevel } from "../utils.js";
import { deleteRefreshTokens, validateRefreshToken } from "../refreshTokens.js";
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
  logWithLevel("DEBUG", "refreshSessionImpl args:", args);
  const { refreshToken } = args;
  const [refreshTokenId, tokenSessionId] = refreshToken.split(
    REFRESH_TOKEN_DIVIDER,
  );
  const validationResult = await validateRefreshToken(
    ctx,
    refreshTokenId,
    tokenSessionId,
  );
  // This invalidates all other refresh tokens for this session,
  // including ones created later, regardless of whether
  // the passed one is valid or not.
  await deleteRefreshTokens(ctx, tokenSessionId as GenericId<"authSessions">);

  if (validationResult === null) {
    // Can't call `deleteSession` here because we already deleted
    // refresh tokens above
    const session = await ctx.db.get(
      tokenSessionId as GenericId<"authSessions">,
    );
    if (session !== null) {
      await ctx.db.delete(session._id);
    }
    return null;
  }
  const { session } = validationResult;
  const sessionId = session._id;
  const userId = session.userId;
  return await generateTokensForSession(ctx, config, userId, sessionId);
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
