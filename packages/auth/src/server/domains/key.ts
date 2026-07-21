import { ConvexError } from "convex/values";

import { ErrorCode } from "../../shared/codes";
import { single } from "../component/api";
import type { ComponentCtx, ComponentReadCtx } from "../component/context";
import { configDefaults } from "../config";
import { emitAuthEvent } from "../events";
import { createScopeChecker, checkKeyRateLimit, generateApiKey, hashApiKey } from "../keys";
import type { Doc, KeyDoc, KeyScope, ScopeChecker } from "../types";

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

export function createKeyDomain(deps: KeyDeps) {
  const { config } = deps;

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
      await emitAuthEvent(ctx, config, {
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
      const k = doc;
      if (k.revoked) {
        throw new ConvexError({
          code: ErrorCode.API_KEY_REVOKED,
          message: "This API key has been revoked.",
        });
      }
      if (k.expiresAt && k.expiresAt < Date.now()) {
        throw new ConvexError({
          code: ErrorCode.API_KEY_EXPIRED,
          message: "This API key has expired.",
        });
      }
      const now = Date.now();
      let patch: Record<string, unknown> | null = null;
      // Rate-limit enforcement, when configured, must always persist the new
      // token-bucket state (that is the whole point of the check).
      //
      // NOTE: the rate-limit check is a read (via `key.get` above, its own
      // transaction) → decide → write (`key.update`, a separate transaction)
      // sequence. Because those are two transactions, two concurrent requests
      // can both read the same `rateLimitState`, both decide "not limited", and
      // both persist a decrement of the *same* starting state — so the true
      // atomic decrement is lost and a burst can slip past the limit. Closing
      // that window needs the read-check-decrement folded into a single
      // component mutation on `ApiKey` (which owns the row's transaction);
      // that mutation lives in `component/user/key.ts`, outside this file's
      // edit scope, so it is left as a follow-up. The coarsening below does not
      // affect the rate-limit path (its state is still written every request).
      if (k.rateLimit) {
        const { limited, newState } = checkKeyRateLimit(k.rateLimit, k.rateLimitState ?? undefined);
        if (limited) {
          throw new ConvexError({
            code: ErrorCode.API_KEY_RATE_LIMITED,
            message: "API key rate limit exceeded. Please try again later.",
          });
        }
        patch = { rateLimitState: newState };
      }
      // Coarsen the `lastUsedAt` touch: only write when it is unset or older
      // than the sampling window, so repeated verifications of the same key
      // within the window do not each issue a write.
      const lastUsedAt = typeof k.lastUsedAt === "number" ? k.lastUsedAt : 0;
      if (now - lastUsedAt >= LAST_USED_COARSEN_MS) {
        patch = { ...patch, lastUsedAt: now };
      }
      // Skip the write entirely in the common hot-path case: no rate limit
      // configured and `lastUsedAt` still fresh — verification stays read-only.
      if (patch !== null) {
        await ctx.runMutation(config.component.user.key.update, {
          id: k._id,
          patch,
        });
      }
      return {
        userId: k.userId,
        keyId: k._id,
        scopes: createScopeChecker(k.scopes),
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
      return (await ctx.runQuery(config.component.user.key.list, {
        where: opts?.where,
        paginationOpts: opts?.paginationOpts ?? { numItems: 50, cursor: null },
        orderBy: opts?.orderBy,
        order: opts?.order,
      })) as Paginated<Doc<"ApiKey">>;
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
    get: async (ctx: ComponentReadCtx, opts: { id: string }): Promise<KeyDoc | null> => {
      const doc = (await ctx.runQuery(config.component.user.key.get, {
        id: opts.id,
      })) as KeyDoc | null;
      return doc ?? null;
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
      const existing = single(await ctx.runQuery(config.component.user.key.get, { id: opts.id }));
      if (!existing) {
        throw new ConvexError({
          code: ErrorCode.INVALID_PARAMETERS,
          message: "The provided parameters are invalid.",
        });
      }
      if (existing.revoked === true) {
        throw new ConvexError({
          code: ErrorCode.API_KEY_REVOKED,
          message: "This API key has been revoked.",
        });
      }
      await ctx.runMutation(config.component.user.key.update, {
        id: opts.id,
        patch: { revoked: true },
      });
      await emitAuthEvent(ctx, config, {
        kind: "api_key.revoked",
        actor: { type: "user", id: existing.userId },
        subject: { type: "user", id: existing.userId },
        targets: [
          { kind: "user", id: existing.userId },
          { kind: "api_key", id: opts.id },
        ],
        outcome: "success",
        data: { keyId: opts.id },
      });
      return await key.create(ctx, {
        data: {
          userId: existing.userId,
          name: opts.name ?? existing.name ?? opts.id,
          scopes: (existing.scopes ?? []) as KeyScope[],
          rateLimit: existing.rateLimit,
          expiresAt: opts.expiresAt,
          extend: existing.extend,
        },
      });
    },
  };

  return key;
}
