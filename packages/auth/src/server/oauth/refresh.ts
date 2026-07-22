import type { AuthComponentApi } from "../component/api";
import type { ComponentCtx } from "../component/context";
import type { configDefaults } from "../config";
import { emitAuthEvent } from "../events";
import { generateRandomString, sha256 } from "../random";

const REFRESH_TOKEN_PREFIX = "rt_";
const REFRESH_TOKEN_LENGTH = 40;
const REFRESH_TOKEN_ALPHABET = "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789";

/**
 * Default OAuth refresh-token lifetime — a rolling 7-day *inactivity* window.
 * Every rotation slides the grant's expiry forward, so an actively-used client
 * (e.g. a desktop MCP client) never re-authorizes; only ~7 days with no refresh
 * at all expires the grant.
 */
export const OAUTH_REFRESH_TOKEN_DURATION_S = 7 * 24 * 60 * 60;
/**
 * Grace window in which a just-rotated token may be replayed without suspicion
 * (slow networks, cold-start latency, retries, pipelined requests). Reuse
 * detection primarily relies on lineage — a replay is only theft once the chain
 * has advanced past the token — so this is a belt-and-suspenders for replays
 * that arrive before the client has rotated forward.
 */
const REUSE_WINDOW_MS = 60_000;

/** The user, scopes, and resource a rotated refresh token grants. */
export interface OAuthRefreshGrant {
  userId: string;
  scopes: string[];
  resource?: string;
}

/** Public API surface for the OAuth refresh sub-domain. */
export interface OAuthRefreshDomain {
  /**
   * Create a refresh token bound to a client, user, scopes, and resource.
   * Returns the opaque token (`rt_*`, only its hash is stored) and its expiry.
   */
  create(
    ctx: ComponentCtx,
    args: {
      clientId: string;
      userId: string;
      scopes: string[];
      resource?: string;
      expiresAt?: number;
    },
  ): Promise<{ refreshToken: string; expiresAt: number }>;

  /**
   * Generate a refresh secret + its lookup hash + expiry WITHOUT persisting it.
   * Used by the authorization-code exchange so the grant/token rows can be
   * inserted in the SAME component transaction that consumes the code (see
   * `oauth.code.accept`'s `refresh` param), making code-consumption and
   * refresh-creation atomic. The caller persists `tokenHash`; the returned
   * `refreshToken` is the opaque secret handed to the client.
   */
  mint(): Promise<{ refreshToken: string; tokenHash: string; expiresAt: number }>;

  /**
   * Rotate a refresh token (RFC 6749 §6). Returns the new opaque token plus the
   * granted user/scopes/resource, or `null` if the token is unknown, bound to a
   * different client, expired, or replayed after the client rotated past it
   * (theft — the whole chain is revoked). Retries and concurrent refreshes that
   * have *not* advanced past the presented token are tolerated and rotate
   * normally. Theft emits an `oauth.refresh.reuse_detected` audit event
   * attributed to the client that *presented* the replayed token — which may be
   * the victim's own client replaying after a glitch, so read it as "chain
   * burned, investigate", not "this client is malicious".
   */
  exchange(
    ctx: ComponentCtx,
    args: { refreshToken: string; clientId: string; requestedScopes?: string[] },
  ): Promise<
    | ({ refreshToken: string; expiresAt: number } & OAuthRefreshGrant)
    | { scopeExceeded: true }
    | null
  >;

  /**
   * Revoke a refresh token and all its descendants. Emits `oauth.refresh.revoked`
   * with `actor: system` when a token matched — until explicit-revoke/sign-out
   * wiring threads a real initiating principal through to here.
   */
  revoke(ctx: ComponentCtx, args: { refreshToken: string }): Promise<void>;
}

function generateRefreshToken(): string {
  return REFRESH_TOKEN_PREFIX + generateRandomString(REFRESH_TOKEN_LENGTH, REFRESH_TOKEN_ALPHABET);
}

/** @internal */
export function createOAuthRefreshDomain(deps: {
  component: AuthComponentApi;
  events?: ReturnType<typeof configDefaults>["events"];
}): OAuthRefreshDomain {
  const component = deps.component;
  return {
    async create(ctx, args) {
      const refreshToken = generateRefreshToken();
      const tokenHash = await sha256(refreshToken);
      const expiresAt = args.expiresAt ?? Date.now() + OAUTH_REFRESH_TOKEN_DURATION_S * 1000;
      await ctx.runMutation(component.oauth.refresh.create, {
        tokenHash,
        clientId: args.clientId,
        userId: args.userId,
        scopes: args.scopes,
        resource: args.resource,
        expiresAt,
      });
      return { refreshToken, expiresAt };
    },

    async mint() {
      const refreshToken = generateRefreshToken();
      const tokenHash = await sha256(refreshToken);
      const expiresAt = Date.now() + OAUTH_REFRESH_TOKEN_DURATION_S * 1000;
      return { refreshToken, tokenHash, expiresAt };
    },

    async exchange(ctx, args) {
      const tokenHash = await sha256(args.refreshToken);
      const refreshToken = generateRefreshToken();
      const newTokenHash = await sha256(refreshToken);
      const expiresAt = Date.now() + OAUTH_REFRESH_TOKEN_DURATION_S * 1000;
      const result = await ctx.runMutation(component.oauth.refresh.exchange, {
        tokenHash,
        newTokenHash,
        clientId: args.clientId,
        now: Date.now(),
        newExpiresAt: expiresAt,
        reuseWindowMs: REUSE_WINDOW_MS,
        requestedScopes: args.requestedScopes,
      });
      if (result.status === "rotated") {
        return {
          refreshToken,
          expiresAt,
          userId: result.userId,
          scopes: result.scopes,
          resource: result.resource,
        };
      }
      if (result.status === "scope_exceeded") {
        return { scopeExceeded: true as const };
      }
      if (result.status === "reuse_detected") {
        await emitAuthEvent(ctx, deps, {
          kind: "oauth.refresh.reuse_detected",
          actor: { type: "oauth_client", id: result.clientId },
          subject: { type: "user", id: result.userId },
          targets: [
            { kind: "oauth_client", id: result.clientId },
            { kind: "user", id: result.userId },
          ],
          outcome: "failure",
          data: { clientId: result.clientId, userId: result.userId },
        });
      }
      return null;
    },

    async revoke(ctx, args) {
      const tokenHash = await sha256(args.refreshToken);
      const revoked = await ctx.runMutation(component.oauth.refresh.revoke, { tokenHash });
      if (revoked === null) return;
      await emitAuthEvent(ctx, deps, {
        kind: "oauth.refresh.revoked",
        actor: { type: "system" },
        subject: { type: "user", id: revoked.userId },
        targets: [
          { kind: "oauth_client", id: revoked.clientId },
          { kind: "user", id: revoked.userId },
        ],
        outcome: "success",
        data: { clientId: revoked.clientId, userId: revoked.userId },
      });
    },
  };
}
