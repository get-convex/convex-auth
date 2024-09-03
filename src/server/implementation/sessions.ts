import { GenericId } from "convex/values";
import { ConvexAuthConfig } from "../index.js";
import { Doc, MutationCtx, SessionInfo } from "./types.js";
import { Auth } from "convex/server";
import { TOKEN_SUB_CLAIM_DIVIDER, stringToNumber } from "./utils.js";
import { generateToken } from "./tokens.js";
import { createRefreshToken, deleteRefreshTokens } from "./refreshTokens.js";

const DEFAULT_SESSION_TOTAL_DURATION_MS = 1000 * 60 * 60 * 24 * 30; // 30 days

export async function maybeGenerateTokensForSession(
  ctx: MutationCtx,
  config: ConvexAuthConfig,
  userId: GenericId<"users">,
  sessionId: GenericId<"authSessions">,
  generateTokens: boolean,
): Promise<SessionInfo> {
  return {
    userId,
    sessionId,
    tokens: generateTokens
      ? await generateTokensForSession(ctx, config, userId, sessionId)
      : null,
  };
}

export async function createNewAndDeleteExistingSession(
  ctx: MutationCtx,
  config: ConvexAuthConfig,
  userId: GenericId<"users">,
) {
  const existingSessionId = await getAuthSessionId(ctx);
  if (existingSessionId !== null) {
    const existingSession = await ctx.db.get(existingSessionId);
    if (existingSession !== null) {
      await deleteSession(ctx, existingSession);
    }
  }
  return await createSession(ctx, userId, config);
}

export async function generateTokensForSession(
  ctx: MutationCtx,
  config: ConvexAuthConfig,
  userId: GenericId<"users">,
  sessionId: GenericId<"authSessions">,
) {
  const ids = { userId, sessionId };
  return {
    token: await generateToken(ids, config),
    refreshToken: await createRefreshToken(ctx, sessionId, config),
  };
}

async function createSession(
  ctx: MutationCtx,
  userId: GenericId<"users">,
  config: ConvexAuthConfig,
) {
  const expirationTime =
    Date.now() +
    (config.session?.totalDurationMs ??
      stringToNumber(process.env.AUTH_SESSION_TOTAL_DURATION_MS) ??
      DEFAULT_SESSION_TOTAL_DURATION_MS);
  return await ctx.db.insert("authSessions", { expirationTime, userId });
}

export async function deleteSession(
  ctx: MutationCtx,
  session: Doc<"authSessions">,
) {
  await ctx.db.delete(session._id);
  await deleteRefreshTokens(ctx, session._id);
}

/**
 * Return the current session ID.
 *
 * ```ts filename="convex/myFunctions.tsx"
 * import { mutation } from "./_generated/server";
 * import { getAuthSessionId } from "@convex-dev/auth/server";
 *
 * export const doSomething = mutation({
 *   args: {/* ... *\/},
 *   handler: async (ctx, args) => {
 *     const sessionId = await getAuthSessionId(ctx);
 *     if (sessionId === null) {
 *       throw new Error("Client is not authenticated!")
 *     }
 *     const session = await ctx.db.get(sessionId);
 *     // ...
 *   },
 * });
 * ```
 *
 * @param ctx query, mutation or action `ctx`
 * @returns the session ID or `null` if the client isn't authenticated
 */
export async function getAuthSessionId(ctx: { auth: Auth }) {
  const identity = await ctx.auth.getUserIdentity();
  if (identity === null) {
    return null;
  }
  const [, sessionId] = identity.subject.split(TOKEN_SUB_CLAIM_DIVIDER);
  return sessionId as GenericId<"authSessions">;
}
