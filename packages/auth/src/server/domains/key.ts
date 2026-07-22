import { ConvexError } from "convex/values";

import { ErrorCode } from "../../shared/codes";
import type { ComponentCtx, ComponentReadCtx } from "../component/context";
import { configDefaults } from "../config";
import { emitAuthEvent } from "../events";
import { createScopeChecker, generateApiKey, hashApiKey } from "../keys";
import type { KeyDoc, KeyRecord, KeyScope, ScopeChecker } from "../types";

/** Convex-native `PaginationResult<T>` shape returned by the `*List` component queries. */
type Paginated<T> = {
  page: T[];
  isDone: boolean;
  continueCursor: string;
  splitCursor?: string | null;
  pageStatus?: "SplitRecommended" | "SplitRequired" | null;
};

export type KeyDeps = {
  config: ReturnType<typeof configDefaults>;
};

/**
 * Sampling window for the `lastUsedAt` touch in {@link createKeyDomain}'s
 * `verify`. Bearer verification runs on every authenticated API-key request, so
 * writing `lastUsedAt` unconditionally turns read-only traffic into a
 * per-request write on a single, potentially very hot `ApiKey` document — a
 * classic OCC contention point when one shared key drives high QPS. `lastUsedAt`
 * only needs coarse ("used ~this minute") accuracy, so the touch is coarsened:
 * skipped unless the stored value is unset or older than this window.
 */
const LAST_USED_COARSEN_MS = 60_000;

/**
 * Public projection of a stored `ApiKey` document. Strips the sensitive
 * `hashedKey` (the SHA-256 lookup hash) and the mutable `rateLimitState`
 * (internal token-bucket counters) so `auth.key.get` / `auth.key.list` never
 * leak them to callers — the returned shape matches {@link KeyRecord}.
 * `auth.key.verify` reads the full component document directly and is
 * unaffected.
 */
function redactKeyRecord(doc: KeyDoc): KeyRecord {
  const { hashedKey: _hashedKey, rateLimitState: _rateLimitState, ...rest } = doc;
  return rest as KeyRecord;
}

export function createKeyDomain(deps: KeyDeps) {
  const { config } = deps;

  // Creation/rotation commits before event append/handlers run. If an event
  // sink fails, the secret cannot be read again; returning an error would hide
  // a live credential from the caller. Preserve the credential response and
  // surface the audit outage operationally instead.
  const emitCommittedKeyEvent = async (
    ctx: ComponentCtx,
    event: Parameters<typeof emitAuthEvent>[2],
  ): Promise<void> => {
    try {
      await emitAuthEvent(ctx, config, event);
    } catch (err) {
      console.error("[auth] API key committed but audit event emission failed", {
        kind: event.kind,
        err,
      });
    }
  };

  const key = {
    /**
     * Create an API key for programmatic access. The returned `secret`
     * (prefixed `sk_`) is shown only once — it is stored as a hash.
     *
     * @param ctx - Convex mutation context.
     * @param opts.data.userId - Owner of the key.
     * @param opts.data.name - Human-readable name (e.g. `"CI Pipeline"`).
     * @param opts.data.scopes - Array of `{ resource, actions }` permission scopes.
     * @param opts.data.rateLimit - Optional per-key rate limit `{ maxRequests, windowMs }`.
     * @param opts.data.expiresAt - Optional expiration timestamp (ms since epoch).
     * @param opts.data.extend - Arbitrary app-specific extend.
     * @returns `{ id, secret }`. Store `secret` securely — it cannot be retrieved later.
     *
     * @example
     * ```ts
     * const { secret } = await auth.key.create(ctx, {
     *   data: {
     *     userId,
     *     name: "CI Pipeline",
     *     scopes: [{ resource: "data", actions: ["read"] }],
     *   },
     * });
     * ```
     */
    create: async (
      ctx: ComponentCtx,
      opts: {
        data: {
          userId: string;
          name: string;
          scopes: KeyScope[];
          rateLimit?: { maxRequests: number; windowMs: number };
          expiresAt?: number;
          extend?: Record<string, unknown>;
        };
      },
    ): Promise<{ id: string; secret: string }> => {
      const data = opts.data;
      const { raw, hashedKey, displayPrefix } = await generateApiKey("sk_");
      const keyId = (await ctx.runMutation(config.component.user.key.create, {
        userId: data.userId,
        prefix: displayPrefix,
        hashedKey,
        name: data.name,
        scopes: data.scopes,
        rateLimit: data.rateLimit,
        expiresAt: data.expiresAt,
        extend: data.extend,
      })) as string;
      await emitCommittedKeyEvent(ctx, {
        kind: "api_key.created",
        actor: { type: "user", id: data.userId },
        subject: { type: "user", id: data.userId },
        targets: [
          { kind: "user", id: data.userId },
          { kind: "api_key", id: keyId },
        ],
        outcome: "success",
        data: { keyId, name: data.name, prefix: displayPrefix },
      });
      return { id: keyId, secret: raw };
    },
    /**
     * Verify an API key and return the owner's identity and scopes.
     *
     * Checks the key against the database, enforces expiration and rate
     * limits, and returns a `ScopeChecker` for permission evaluation.
     *
     * @param ctx - Convex mutation context (updates `lastUsedAt` and rate limit state).
     * @param opts.secret - The raw `sk_*` key string.
     * @returns `{ userId, keyId, scopes }` where `scopes.can(resource, action)` checks permissions.
     * @throws `INVALID_API_KEY` if the key is not found.
     * @throws `API_KEY_REVOKED` if the key was revoked.
     * @throws `API_KEY_EXPIRED` if the key is past its `expiresAt`.
     * @throws `API_KEY_RATE_LIMITED` if the rate limit is exceeded.
     *
     * @example
     * ```ts
     * const { userId, scopes } = await auth.key.verify(ctx, { secret: rawKey });
     * const canRead = scopes.can("data", "read");
     * ```
     */
    verify: async (
      ctx: ComponentCtx,
      opts: { secret: string },
    ): Promise<{ userId: string; keyId: string; scopes: ScopeChecker }> => {
      const hashedKey = await hashApiKey(opts.secret);
      const doc = (await ctx.runQuery(config.component.user.key.get, {
        hashedKey,
      })) as KeyDoc | null;
      if (!doc) {
        throw new ConvexError({
          code: ErrorCode.INVALID_API_KEY,
          message: "Invalid API key.",
        });
      }
      // Make the successful verification decision and update usage in ONE
      // component mutation on the `ApiKey` row. The hash lookup above only
      // locates the row: `recordUse` re-reads its current state transactionally
      // and returns the current owner and scopes. This closes both the original
      // rate-limit race and the query → mutation window where deletion,
      // revocation, expiration, or a scope reduction could otherwise be missed.
      //
      // `coarsenMs` keeps the hot-path optimization: `recordUse` skips the
      // `lastUsedAt` write when it is still within the window (and no rate-limit
      // decrement forces a write), so read-only bearer traffic on a hot key does
      // not turn into a per-request write.
      const result = (await ctx.runMutation(config.component.user.key.recordUse, {
        id: doc._id,
        now: Date.now(),
        coarsenMs: LAST_USED_COARSEN_MS,
      })) as unknown as
        | { status: "invalid" | "revoked" | "expired" | "limited" }
        | {
            status: "verified";
            keyId: string;
            userId: string;
            scopes: KeyScope[];
          };
      switch (result.status) {
        case "invalid":
          throw new ConvexError({
            code: ErrorCode.INVALID_API_KEY,
            message: "Invalid API key.",
          });
        case "revoked":
          throw new ConvexError({
            code: ErrorCode.API_KEY_REVOKED,
            message: "This API key has been revoked.",
          });
        case "expired":
          throw new ConvexError({
            code: ErrorCode.API_KEY_EXPIRED,
            message: "This API key has expired.",
          });
        case "limited":
          throw new ConvexError({
            code: ErrorCode.API_KEY_RATE_LIMITED,
            message: "API key rate limit exceeded. Please try again later.",
          });
      }
      return {
        userId: result.userId,
        keyId: result.keyId,
        scopes: createScopeChecker(result.scopes),
      };
    },
    /**
     * List API keys with optional filtering by user, revocation status, name,
     * or prefix. Results are paginated. Does not expose raw key secrets.
     *
     * @param ctx - Convex query or mutation context.
     * @param opts.where - Filter criteria (all optional, combined with AND).
     * @param opts.paginationOpts - Convex pagination options.
     * @param opts.orderBy - Sort field: `"_creationTime"`, `"name"`, `"lastUsedAt"`, `"expiresAt"`, or `"revoked"`.
     * @param opts.order - Sort direction: `"asc"` or `"desc"`.
     * @returns Convex `PaginationResult` — `{ page, isDone, continueCursor }`.
     *
     * @example
     * ```ts
     * const { page } = await auth.key.list(ctx, {
     *   where: { userId, revoked: false },
     *   paginationOpts: { numItems: 25, cursor: null },
     *   orderBy: "lastUsedAt",
     *   order: "desc",
     * });
     * ```
     */
    list: async (
      ctx: ComponentReadCtx,
      opts?: {
        where?: {
          userId?: string;
          revoked?: boolean;
          name?: string;
          prefix?: string;
        };
        paginationOpts: { numItems: number; cursor: string | null };
        orderBy?: "_creationTime" | "name" | "lastUsedAt" | "expiresAt" | "revoked";
        order?: "asc" | "desc";
      },
    ) => {
      const result = (await ctx.runQuery(config.component.user.key.list, {
        where: opts?.where,
        paginationOpts: opts?.paginationOpts ?? { numItems: 50, cursor: null },
        orderBy: opts?.orderBy,
        order: opts?.order,
      })) as Paginated<KeyDoc>;
      return { ...result, page: result.page.map(redactKeyRecord) };
    },
    /**
     * Fetch an API key record by ID. Does not expose the raw key secret.
     *
     * Returns the key document including extend, scopes, rate limit
     * configuration, and revocation status. The raw secret is never
     * stored or returned — only the hashed key and display prefix.
     *
     * @param ctx - Convex query or mutation context.
     * @param opts.id - The API key's document ID.
     * @returns The key document, or `null` if not found.
     *
     * @example
     * ```ts
     * const key = await auth.key.get(ctx, { id: keyId });
     * if (!key) throw new Error("Key not found");
     * console.log(key.name, key.prefix);
     * ```
     */
    get: async (ctx: ComponentReadCtx, opts: { id: string }): Promise<KeyRecord | null> => {
      const doc = (await ctx.runQuery(config.component.user.key.get, {
        id: opts.id,
      })) as KeyDoc | null;
      return doc === null ? null : redactKeyRecord(doc);
    },
    /**
     * Update a key's name, scopes, or rate limit.
     *
     * Patches the specified fields on the API key document. Only the
     * provided fields are changed — omitted fields remain unchanged.
     *
     * @param ctx - Convex mutation context.
     * @param opts.id - The API key's document ID.
     * @param opts.patch - Fields to merge into the key document.
     * @returns `null`.
     *
     * @example
     * ```ts
     * await auth.key.update(ctx, {
     *   id: keyId,
     *   patch: {
     *     name: "CI Pipeline (updated)",
     *     scopes: [{ resource: "data", actions: ["read", "write"] }],
     *   },
     * });
     * ```
     */
    update: async (
      ctx: ComponentCtx,
      opts: {
        id: string;
        patch: {
          name?: string;
          scopes?: KeyScope[];
          rateLimit?: { maxRequests: number; windowMs: number };
        };
      },
    ) => {
      await ctx.runMutation(config.component.user.key.update, {
        id: opts.id,
        patch: opts.patch,
      });
      return null;
    },
    /**
     * Soft-delete: set `revoked: true`. The key can no longer be verified.
     *
     * After revocation, any subsequent calls to `auth.key.verify` with
     * this key will throw `API_KEY_REVOKED`.
     * The key record is preserved for audit purposes.
     *
     * @param ctx - Convex mutation context.
     * @param opts.id - The API key's document ID.
     * @returns `null`.
     *
     * @example
     * ```ts
     * await auth.key.revoke(ctx, { id: keyId });
     * ```
     */
    revoke: async (ctx: ComponentCtx, opts: { id: string }) => {
      const key = (await ctx.runQuery(config.component.user.key.get, {
        id: opts.id,
      })) as KeyDoc | null;
      await ctx.runMutation(config.component.user.key.update, {
        id: opts.id,
        patch: { revoked: true },
      });
      if (key !== null) {
        await emitAuthEvent(ctx, config, {
          kind: "api_key.revoked",
          actor: { type: "user", id: key.userId },
          subject: { type: "user", id: key.userId },
          targets: [
            { kind: "user", id: key.userId },
            { kind: "api_key", id: opts.id },
          ],
          outcome: "success",
          data: { keyId: opts.id },
        });
      }
      return null;
    },
    /**
     * Hard-delete: permanently remove the key record.
     *
     * Unlike `revoke`, this permanently removes the key document from
     * the database. Use this when you need to fully clean up a key
     * rather than preserving it for audit history.
     *
     * @param ctx - Convex mutation context.
     * @param opts.id - The API key's document ID.
     * @returns `null`.
     *
     * @example
     * ```ts
     * await auth.key.remove(ctx, { id: keyId });
     * ```
     */
    remove: async (ctx: ComponentCtx, opts: { id: string }) => {
      await ctx.runMutation(config.component.user.key.remove, { id: opts.id });
      return null;
    },
    /**
     * Rotate a key: revokes the old key and creates a new one with the
     * same user, scopes, and rate limit. Returns the new `id` and `secret`.
     * Throws if the key does not exist or is already revoked.
     *
     * @param ctx - Convex mutation context.
     * @param opts.id - The existing API key's document ID to rotate.
     * @param opts.name - Optional new name for the rotated key (defaults to the old name).
     * @param opts.expiresAt - Optional new expiration timestamp in ms since epoch.
     * @returns `{ id, secret }` with the new key.
     * @throws `INVALID_PARAMETERS` if the key does not exist.
     * @throws `API_KEY_REVOKED` if the key is already revoked.
     *
     * @example
     * ```ts
     * const { id, secret } = await auth.key.rotate(ctx, {
     *   id: oldKeyId,
     *   expiresAt: Date.now() + 30 * 24 * 60 * 60 * 1000, // 30 days
     * });
     * // Store secret securely — shown only once
     * ```
     */
    rotate: async (
      ctx: ComponentCtx,
      opts: { id: string; name?: string; expiresAt?: number },
    ): Promise<{ id: string; secret: string }> => {
      const { raw, hashedKey, displayPrefix } = await generateApiKey("sk_");
      const result = (await ctx.runMutation((config.component.user.key as any).rotate, {
        id: opts.id,
        prefix: displayPrefix,
        hashedKey,
        name: opts.name,
        expiresAt: opts.expiresAt,
      })) as
        | { status: "invalid" }
        | { status: "revoked" }
        | { status: "invalid_rate_limit" }
        | { status: "rotated"; id: string; userId: string; name: string };
      if (result.status === "invalid") {
        throw new ConvexError({
          code: ErrorCode.INVALID_PARAMETERS,
          message: "The provided parameters are invalid.",
        });
      }
      if (result.status === "revoked") {
        throw new ConvexError({
          code: ErrorCode.API_KEY_REVOKED,
          message: "This API key has been revoked.",
        });
      }
      if (result.status === "invalid_rate_limit") {
        throw new ConvexError({
          code: ErrorCode.INVALID_PARAMETERS,
          message: "The API key has an invalid rate limit configuration.",
        });
      }
      await emitCommittedKeyEvent(ctx, {
        kind: "api_key.revoked",
        actor: { type: "user", id: result.userId },
        subject: { type: "user", id: result.userId },
        targets: [
          { kind: "user", id: result.userId },
          { kind: "api_key", id: opts.id },
        ],
        outcome: "success",
        data: { keyId: opts.id },
      });
      await emitCommittedKeyEvent(ctx, {
        kind: "api_key.created",
        actor: { type: "user", id: result.userId },
        subject: { type: "user", id: result.userId },
        targets: [
          { kind: "user", id: result.userId },
          { kind: "api_key", id: result.id },
        ],
        outcome: "success",
        data: { keyId: result.id, name: result.name, prefix: displayPrefix },
      });
      return { id: result.id, secret: raw };
    },
  };

  return key;
}
