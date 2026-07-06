import type { GenericDataModel } from "convex/server";
import { GenericId, Infer, v } from "convex/values";

import type { AuthTokens } from "../../shared/results";
import type * as Provider from "../crypto";
import { authDb } from "../db";
import { emitAuthEvent } from "../events";
import { log, maybeRedact } from "../log";
import {
  encodeRefreshToken,
  parseRefreshToken,
  REFRESH_TOKEN_REUSE_WINDOW_MS,
  refreshTokenExpirationTime,
} from "../token/refresh";
import { buildSessionIdentity, finalizeSessionIssuance } from "../session/lifecycle";
import type { SessionIssuance } from "../session/lifecycle";
import { buildRefreshIdentityAttributes } from "../telemetry";
import {
  GenericActionCtxWithAuthConfig,
  type Doc,
  type MutationCtx,
  type SessionInfo,
} from "../types";
import { setActiveSpanAttributes, withSpan } from "../utils/span";
import { AUTH_STORE_REF } from "./store/refs";

export const vRefreshSessionArgs = v.object({
  refreshToken: v.string(),
});

/**
 * Exchange a refresh token and mint the next pair of session IDs + refresh
 * token string. The RSA-2048 JWT signing used to live here; it has been
 * moved to the action wrapper ({@link callRefreshSession}) so the mutation
 * can commit without paying 5–30ms of CPU per refresh.
 *
 * @internal
 */
export async function refreshSessionImpl(
  ctx: MutationCtx,
  args: Infer<typeof vRefreshSessionArgs>,
  config: Provider.Config,
): Promise<SessionIssuance | null> {
  const db = authDb(ctx, config);

  return withSpan(
    "convex-auth.refresh.session",
    { hasRefreshToken: true, "auth.flow": "refresh" },
    async () => {
      try {
        let refreshTokenId: GenericId<"RefreshToken">;
        let sessionId: GenericId<"Session">;
        try {
          ({ refreshTokenId, sessionId } = parseRefreshToken(args.refreshToken));
        } catch {
          throw new RefreshFailure("parse_failure", "Failed to parse refresh token");
        }

        log(
          "DEBUG",
          `refreshSessionImpl args: Token ID: ${maybeRedact(refreshTokenId)} Session ID: ${maybeRedact(sessionId)}`,
        );

        let exchanged;
        try {
          exchanged = await db.refreshTokens.exchange({
            refreshTokenId,
            sessionId,
            now: Date.now(),
            refreshTokenExpirationTime: refreshTokenExpirationTime(config),
            reuseWindowMs: REFRESH_TOKEN_REUSE_WINDOW_MS,
          });
        } catch {
          throw new RefreshFailure("exchange_failure", "Failed to exchange refresh token");
        }

        if (exchanged.status === "reuse_detected") {
          setActiveSpanAttributes({ "auth.refresh.result": "reuse_detected" });
          await emitAuthEvent(ctx, config, {
            kind: "session.refresh_reuse_detected",
            actor: { type: "system" },
            subject: { type: "session", id: sessionId },
            targets: [
              { kind: "user", id: exchanged.userId },
              { kind: "session", id: sessionId },
              { kind: "global", id: "security" },
            ],
            outcome: "failure",
            data: { userId: exchanged.userId, refreshTokenId: exchanged.refreshTokenId },
          });
          return null;
        }

        if (exchanged.status === "invalid") {
          setActiveSpanAttributes({ "auth.refresh.result": "null" });
          return null;
        }

        setActiveSpanAttributes({
          "auth.refresh.result": "success",
          ...(await buildRefreshIdentityAttributes(ctx, config, {
            userId: exchanged.userId,
            sessionId: exchanged.sessionId,
            refreshTokenId: exchanged.refreshTokenId,
          })),
        });

        await emitAuthEvent(ctx, config, {
          kind: "session.refresh_exchanged",
          actor: { type: "system" },
          subject: { type: "session", id: exchanged.sessionId },
          targets: [
            { kind: "user", id: exchanged.userId },
            { kind: "session", id: exchanged.sessionId },
          ],
          outcome: "success",
          data: { sessionId: exchanged.sessionId },
        });

        const user = (await db.users.get({ id: exchanged.userId })) as Doc<"User"> | null;

        return {
          userId: exchanged.userId as GenericId<"User">,
          sessionId: exchanged.sessionId as GenericId<"Session">,
          identity: buildSessionIdentity(
            exchanged.userId as GenericId<"User">,
            exchanged.sessionId as GenericId<"Session">,
            user,
          ),
          refreshToken: encodeRefreshToken(
            exchanged.refreshTokenId as GenericId<"RefreshToken">,
            exchanged.sessionId as GenericId<"Session">,
          ),
        } satisfies SessionIssuance;
      } catch (e) {
        if (e instanceof RefreshFailure) {
          setActiveSpanAttributes({
            "auth.refresh.result": e.code,
            "auth.refresh.failure_reason": e.reason,
          });
          log("DEBUG", e.reason);
          return null;
        }
        throw e;
      }
    },
  );
}

class RefreshFailure extends Error {
  constructor(
    public code: "parse_failure" | "exchange_failure",
    public reason: string,
  ) {
    super(reason);
  }
}

/**
 * Action-side wrapper: exchange the refresh token via the mutation, then
 * sign the next JWT outside the mutation transaction. See
 * {@link refreshSessionImpl} for the rationale.
 *
 * @internal
 */
export const callRefreshSession = async <DataModel extends GenericDataModel>(
  ctx: GenericActionCtxWithAuthConfig<DataModel>,
  args: Infer<typeof vRefreshSessionArgs>,
): Promise<SessionInfo<AuthTokens> | null> => {
  const issuance = (await ctx.runMutation(AUTH_STORE_REF, {
    args: {
      type: "refreshSession",
      ...args,
    },
  })) as SessionIssuance | null;
  if (issuance === null || issuance.refreshToken === null) {
    return null;
  }
  return (await finalizeSessionIssuance(ctx.auth.config, issuance)) as SessionInfo<AuthTokens>;
};
