import { Auth } from "convex/server";
import { GenericId } from "convex/values";

import type { RefreshToken } from "../../shared/brand";
import { authDb } from "../db";
import { envOptionalNumber, readConfigSync } from "../env";
import { emitAuthEvent } from "../events";
import { getAuthenticatedSessionIdOrNull } from "../identity/claims";
import { LOG_LEVELS, log, maybeRedact } from "../log";
import { encodeRefreshToken, refreshTokenExpirationTime } from "../token/refresh";
import { generateToken } from "../tokens";
import {
  ConvexAuthConfig,
  Doc,
  MutationCtx,
  SessionInfo,
  SessionTokenIdentityClaims,
} from "../types";
import { withSpan } from "../utils/span";

const DEFAULT_SESSION_TOTAL_DURATION_MS = 1000 * 60 * 60 * 24 * 30;

/**
 * Absolute expiration timestamp (ms) for a new session.
 *
 * Resolved from `config.session.totalDurationMs`, then the
 * `AUTH_SESSION_TOTAL_DURATION_MS` env var, defaulting to 30 days.
 *
 * @internal
 */
export const sessionExpirationTime = (config: ConvexAuthConfig, now = Date.now()) =>
  now +
  (config.session?.totalDurationMs ??
    readConfigSync(envOptionalNumber("AUTH_SESSION_TOTAL_DURATION_MS")) ??
    DEFAULT_SESSION_TOTAL_DURATION_MS);

/**
 * Mutation-side session issuance result. The mutation creates the session
 * and refresh-token rows; JWT signing happens on the action side so the
 * transaction commits without paying the signing CPU cost.
 */
export type SessionIssuance = {
  userId: GenericId<"User">;
  sessionId: GenericId<"Session">;
  identity: SessionTokenIdentityClaims;
  /**
   * Encoded refresh token (`${refreshTokenId}|${sessionId}`), or `null` when
   * the caller opted out of refresh-token issuance (e.g. TOTP step-up).
   */
  refreshToken: RefreshToken | null;
};

/**
 * Build the JWT identity-claim set for a session from the user document.
 *
 * Shared by {@link issueSession} and the refresh exchange so both mint
 * identical claims from the same user fields.
 *
 * @internal
 */
export function buildSessionIdentity(
  userId: GenericId<"User">,
  sessionId: GenericId<"Session">,
  user: Doc<"User"> | null,
): SessionTokenIdentityClaims {
  return {
    subject: userId,
    sessionId,
    ...(typeof user?.name === "string" ? { name: user.name } : null),
    ...(typeof user?.email === "string" ? { email: user.email } : null),
    ...(user?.emailVerificationTime !== undefined
      ? { emailVerified: true }
      : user?.email !== undefined
        ? { emailVerified: false }
        : null),
    ...(typeof user?.image === "string" ? { picture: user.image } : null),
    ...(typeof user?.phone === "string" ? { phoneNumber: user.phone } : null),
    ...(user?.phoneVerificationTime !== undefined
      ? { phoneNumberVerified: true }
      : user?.phone !== undefined
        ? { phoneNumberVerified: false }
        : null),
  };
}

/**
 * Convert a {@link SessionIssuance} returned from a mutation into the
 * external `SessionInfo` shape by signing the JWT on the action side.
 *
 * Must be called from an action context because `generateToken` performs
 * RSA-2048 JWT signing that would otherwise block the mutation commit.
 *
 * @internal
 */
export async function finalizeSessionIssuance(
  config: ConvexAuthConfig,
  issuance: SessionIssuance,
): Promise<SessionInfo> {
  return withSpan(
    "convex-auth.session.finalize",
    { hasRefreshToken: issuance.refreshToken !== null },
    async () => {
      if (issuance.refreshToken === null) {
        return {
          userId: issuance.userId,
          sessionId: issuance.sessionId,
          tokens: null,
        };
      }
      const token = await generateToken({ identity: issuance.identity }, config);
      log(
        LOG_LEVELS.DEBUG,
        `Generated token ${maybeRedact(token)} and refresh token ${maybeRedact(issuance.refreshToken)} for session ${maybeRedact(issuance.sessionId)}`,
      );
      return {
        userId: issuance.userId,
        sessionId: issuance.sessionId,
        tokens: { token, refreshToken: issuance.refreshToken },
      };
    },
  );
}

/**
 * Create (or extend/replace) a session and its refresh-token row, returning the
 * mutation-side {@link SessionIssuance} for later JWT finalization.
 *
 * @param args.generateTokens - When `false`, no refresh token is issued
 *   (e.g. TOTP step-up that defers token issuance to a second factor).
 * @internal
 */
export async function issueSession(
  ctx: MutationCtx,
  config: ConvexAuthConfig,
  args: {
    userId: GenericId<"User">;
    existingSessionId?: GenericId<"Session">;
    replaceSessionId?: GenericId<"Session">;
    generateTokens: boolean;
  },
): Promise<SessionIssuance> {
  const db = authDb(ctx, config);
  const issued = (await db.sessions.create({
    userId: args.userId,
    sessionId: args.existingSessionId,
    replaceSessionId: args.replaceSessionId,
    sessionExpirationTime: sessionExpirationTime(config),
    refreshTokenExpirationTime: args.generateTokens
      ? refreshTokenExpirationTime(config)
      : undefined,
  })) as {
    userId: string;
    sessionId: string;
    refreshTokenId?: string;
    replacedSessionId?: string;
  };
  const sessionId = issued.sessionId as GenericId<"Session">;
  const refreshTokenId = issued.refreshTokenId as GenericId<"RefreshToken"> | undefined;
  if (issued.replacedSessionId !== undefined) {
    const replacedSessionId = issued.replacedSessionId as GenericId<"Session">;
    await emitAuthEvent(ctx, config, {
      kind: "session.invalidated",
      actor: { type: "system" },
      subject: { type: "session", id: replacedSessionId },
      targets: [
        { kind: "user", id: issued.userId as GenericId<"User"> },
        { kind: "session", id: replacedSessionId },
      ],
      outcome: "success",
      data: { userId: issued.userId, reason: "replaced" },
    });
  }
  const user = (await db.users.get({ id: issued.userId })) as Doc<"User"> | null;
  return {
    userId: issued.userId as GenericId<"User">,
    sessionId,
    identity: buildSessionIdentity(issued.userId as GenericId<"User">, sessionId, user),
    refreshToken:
      args.generateTokens && refreshTokenId !== undefined
        ? encodeRefreshToken(refreshTokenId, sessionId)
        : null,
  };
}

/**
 * Delete a session and all of its refresh tokens.
 *
 * @internal
 */
export async function deleteSession(
  ctx: MutationCtx,
  session: Doc<"Session">,
  config: ConvexAuthConfig,
) {
  const db = authDb(ctx, config);
  await db.sessions.delete(session._id);
  await db.refreshTokens.deleteAll(session._id);
}

/**
 * Return the current session ID from the auth identity subject.
 *
 * @internal
 */
export async function getAuthSessionId(ctx: { auth: Auth }) {
  return await getAuthenticatedSessionIdOrNull(ctx);
}
