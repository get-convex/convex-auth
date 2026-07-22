/**
 * `component.user.key.*` — API keys (programmatic access credentials,
 * a sub-resource of user).
 *
 * Reads collapse into one overloaded `get`.
 *
 * @module
 */

import { paginationOptsValidator } from "convex/server";
import { ConvexError, v } from "convex/values";
import { stream } from "convex-helpers/server/stream";
import { ErrorCode } from "../../shared/codes";

import { mutation, query } from "../functions";
import schema from "../schema";
import {
  vApiKeyDoc,
  vApiKeyRateLimit,
  vApiKeyRateLimitState,
  vApiKeyScope,
  vPaginated,
} from "../model";

type ApiKeyRateLimit = { maxRequests: number; windowMs: number };

function isValidRateLimit(rateLimit: ApiKeyRateLimit): boolean {
  return (
    Number.isSafeInteger(rateLimit.maxRequests) &&
    rateLimit.maxRequests > 0 &&
    Number.isFinite(rateLimit.windowMs) &&
    rateLimit.windowMs > 0
  );
}

function assertValidRateLimit(rateLimit: ApiKeyRateLimit | undefined): void {
  if (rateLimit !== undefined && !isValidRateLimit(rateLimit)) {
    throw new ConvexError({
      code: ErrorCode.INVALID_PARAMETERS,
      message:
        "API key rate limits require a positive integer maxRequests and positive finite windowMs.",
    });
  }
}

/**
 * Read an API key by id, or by `hashedKey` when given. Returns `null` when no
 * selector matches.
 */
export const get = query({
  args: {
    id: v.optional(v.id("ApiKey")),
    hashedKey: v.optional(v.string()),
  },
  returns: v.union(vApiKeyDoc, v.null()),
  handler: async (ctx, args) => {
    if (args.hashedKey !== undefined) {
      return await ctx.db
        .query("ApiKey")
        .withIndex("hashed_key", (q) => q.eq("hashedKey", args.hashedKey!))
        .first();
    }
    if (args.id === undefined) return null;
    return await ctx.db.get("ApiKey", args.id);
  },
});

/** List API keys, paginated, with optional `where` filters and ordering. */
export const list = query({
  args: {
    where: v.optional(
      v.object({
        userId: v.optional(v.id("User")),
        revoked: v.optional(v.boolean()),
        name: v.optional(v.string()),
        prefix: v.optional(v.string()),
      }),
    ),
    paginationOpts: paginationOptsValidator,
    orderBy: v.optional(
      v.union(
        v.literal("_creationTime"),
        v.literal("name"),
        v.literal("lastUsedAt"),
        v.literal("expiresAt"),
        v.literal("revoked"),
      ),
    ),
    order: v.optional(v.union(v.literal("asc"), v.literal("desc"))),
  },
  returns: vPaginated(vApiKeyDoc),
  handler: async (ctx, args) => {
    const where = args.where ?? {};
    const order = args.order ?? "desc";

    const base = stream(ctx.db, schema).query("ApiKey");
    let q;
    if (where.userId !== undefined) {
      q = base.withIndex("user_id", (idx) => idx.eq("userId", where.userId!));
    } else {
      q = base;
    }

    return await q
      .order(order)
      .filterWith(
        async (d) =>
          (where.revoked === undefined || d.revoked === where.revoked) &&
          (where.name === undefined || d.name === where.name) &&
          (where.prefix === undefined || d.prefix === where.prefix),
      )
      .paginate(args.paginationOpts);
  },
});

/** Insert a new API key (stamped `createdAt`, `revoked: false`). */
export const create = mutation({
  args: {
    userId: v.id("User"),
    prefix: v.string(),
    hashedKey: v.string(),
    name: v.string(),
    scopes: v.array(
      v.object({
        resource: v.string(),
        actions: v.array(v.string()),
      }),
    ),
    rateLimit: v.optional(vApiKeyRateLimit),
    expiresAt: v.optional(v.number()),
    extend: v.optional(v.any()),
  },
  returns: v.id("ApiKey"),
  handler: async (ctx, args) => {
    assertValidRateLimit(args.rateLimit);
    return await ctx.db.insert("ApiKey", {
      ...args,
      createdAt: Date.now(),
      revoked: false,
    });
  },
});

/** Patch fields on an API key; throws `KEY_NOT_FOUND` if it does not exist. */
export const update = mutation({
  args: {
    id: v.id("ApiKey"),
    patch: v.object({
      name: v.optional(v.string()),
      scopes: v.optional(v.array(vApiKeyScope)),
      rateLimit: v.optional(vApiKeyRateLimit),
      rateLimitState: v.optional(vApiKeyRateLimitState),
      revoked: v.optional(v.boolean()),
      lastUsedAt: v.optional(v.number()),
    }),
  },
  returns: v.null(),
  handler: async (ctx, { id: keyId, patch }) => {
    assertValidRateLimit(patch.rateLimit);
    const key = await ctx.db.get("ApiKey", keyId);
    if (key === null) {
      throw new ConvexError({
        code: ErrorCode.KEY_NOT_FOUND,
        message: "API key not found",
        keyId,
      });
    }
    await ctx.db.patch("ApiKey", keyId, patch);
    return null;
  },
});

/**
 * Atomically enforce an API key's rate limit and refresh `lastUsedAt`, folding
 * the read → check → decrement of the token bucket into a SINGLE transaction on
 * the `ApiKey` row.
 *
 * The facade previously split that read (`key.get`) from the decrement
 * (`key.update`) across two transactions, so two concurrent verifications could
 * both read the same starting `rateLimitState`, both decide "not limited", and
 * both persist a decrement of the *same* state — the true atomic decrement was
 * lost and a burst could slip past the limit. Performing the whole
 * check-and-decrement here closes that window: the row's transaction serializes
 * concurrent callers, so each consumes its own token.
 *
 * The verification decision is made from the same transactional snapshot as
 * the rate-limit update. In particular, the mutation re-checks deletion,
 * revocation, expiration, and the current scopes instead of trusting the
 * facade's earlier hash lookup. A successful result returns the current owner
 * and scopes so a concurrent scope reduction cannot authenticate with stale
 * permissions.
 *
 * Returns `{ status: "limited" }` WITHOUT writing when the bucket is empty
 * (mirroring the facade's prior behavior of throwing before its update on the
 * limited branch); otherwise decrements the bucket (when configured) and
 * refreshes `lastUsedAt`. The token bucket refills linearly over the configured
 * window (the same algorithm as sign-in rate limiting); the math is inlined
 * here because component code cannot import from the server bundle.
 *
 * `lastUsedAt` is coarsened by the optional `coarsenMs` window: it is only
 * rewritten when unset or older than the window, so read-only bearer traffic on
 * a hot key stays read-only (no per-request write). When a rate-limit decrement
 * forces a write anyway, a fresh `lastUsedAt` is simply left as-is. Omitting
 * `coarsenMs` (or passing `0`) disables coarsening and refreshes every call.
 */
export const recordUse = mutation({
  args: { id: v.id("ApiKey"), now: v.number(), coarsenMs: v.optional(v.number()) },
  returns: v.union(
    v.object({ status: v.literal("invalid") }),
    v.object({ status: v.literal("revoked") }),
    v.object({ status: v.literal("expired") }),
    v.object({ status: v.literal("limited") }),
    v.object({
      status: v.literal("verified"),
      keyId: v.id("ApiKey"),
      userId: v.id("User"),
      scopes: v.array(vApiKeyScope),
    }),
  ),
  handler: async (ctx, { id: keyId, coarsenMs }) => {
    // Use the mutation's trusted transaction clock for validity and bucket
    // math. `now` remains in the argument shape for compatibility with the
    // existing component reference, but callers cannot use it to bypass
    // expiration or refill a bucket from an arbitrary timestamp.
    const now = Date.now();
    const key = await ctx.db.get("ApiKey", keyId);
    if (key === null) {
      return { status: "invalid" as const };
    }
    if (key.revoked) {
      return { status: "revoked" as const };
    }
    if (key.expiresAt !== undefined && key.expiresAt < now) {
      return { status: "expired" as const };
    }
    const patch: {
      rateLimitState?: { attemptsLeft: number; lastAttemptTime: number };
      lastUsedAt?: number;
    } = {};
    if (key.rateLimit) {
      // Legacy rows may predate write-time validation. Treat malformed
      // configuration or bucket state as exhausted instead of letting NaN,
      // infinity, or a non-positive limit authenticate a request.
      if (!isValidRateLimit(key.rateLimit)) {
        return { status: "limited" as const };
      }
      const state = key.rateLimitState;
      if (!state) {
        patch.rateLimitState = {
          attemptsLeft: key.rateLimit.maxRequests - 1,
          lastAttemptTime: now,
        };
      } else {
        if (
          !Number.isFinite(state.attemptsLeft) ||
          state.attemptsLeft < 0 ||
          !Number.isFinite(state.lastAttemptTime) ||
          state.lastAttemptTime < 0
        ) {
          return { status: "limited" as const };
        }
        const elapsed = Math.max(0, now - state.lastAttemptTime);
        const refillRate = key.rateLimit.maxRequests / key.rateLimit.windowMs;
        if (!Number.isFinite(refillRate)) {
          return { status: "limited" as const };
        }
        const refilled = Math.min(
          key.rateLimit.maxRequests,
          state.attemptsLeft + elapsed * refillRate,
        );
        if (!Number.isFinite(refilled)) {
          return { status: "limited" as const };
        }
        if (refilled < 1) {
          // Bucket empty: reject WITHOUT writing (matches the prior facade,
          // which threw before its single `update`, leaving state untouched).
          return { status: "limited" as const };
        }
        patch.rateLimitState = { attemptsLeft: refilled - 1, lastAttemptTime: now };
      }
    }
    // Coarsen the `lastUsedAt` touch: only stamp it when unset or older than the
    // caller's sampling window. With `coarsenMs` unset/0 the window is 0, so it
    // refreshes every call.
    const window = coarsenMs ?? 0;
    const lastUsedAt = typeof key.lastUsedAt === "number" ? key.lastUsedAt : 0;
    if (now - lastUsedAt >= window) {
      patch.lastUsedAt = now;
    }
    // Nothing to persist — no rate-limit decrement and `lastUsedAt` still fresh:
    // the hot path stays read-only.
    if (patch.rateLimitState === undefined && patch.lastUsedAt === undefined) {
      return {
        status: "verified" as const,
        keyId: key._id,
        userId: key.userId,
        scopes: key.scopes,
      };
    }
    await ctx.db.patch("ApiKey", keyId, patch);
    return {
      status: "verified" as const,
      keyId: key._id,
      userId: key.userId,
      scopes: key.scopes,
    };
  },
});

/**
 * Atomically revoke an active API key and create its replacement.
 *
 * The caller pre-generates the replacement secret and passes only its hash and
 * display prefix. Reading the old row, validating its state, revoking it, and
 * inserting the replacement happen in one transaction, so concurrent rotations
 * cannot both mint a usable successor and an insert failure cannot strand the
 * caller with a revoked key and no replacement.
 */
export const rotate = mutation({
  args: {
    id: v.id("ApiKey"),
    prefix: v.string(),
    hashedKey: v.string(),
    name: v.optional(v.string()),
    expiresAt: v.optional(v.number()),
  },
  returns: v.union(
    v.object({ status: v.literal("invalid") }),
    v.object({ status: v.literal("revoked") }),
    v.object({ status: v.literal("invalid_rate_limit") }),
    v.object({
      status: v.literal("rotated"),
      id: v.id("ApiKey"),
      userId: v.id("User"),
      name: v.string(),
    }),
  ),
  handler: async (ctx, args) => {
    const existing = await ctx.db.get("ApiKey", args.id);
    if (existing === null) {
      return { status: "invalid" as const };
    }
    if (existing.revoked) {
      return { status: "revoked" as const };
    }
    if (existing.rateLimit !== undefined && !isValidRateLimit(existing.rateLimit)) {
      return { status: "invalid_rate_limit" as const };
    }

    const name = args.name ?? existing.name;
    await ctx.db.patch("ApiKey", existing._id, { revoked: true });
    const id = await ctx.db.insert("ApiKey", {
      userId: existing.userId,
      prefix: args.prefix,
      hashedKey: args.hashedKey,
      name,
      scopes: existing.scopes,
      rateLimit: existing.rateLimit,
      expiresAt: args.expiresAt,
      createdAt: Date.now(),
      revoked: false,
      extend: existing.extend,
    });
    return {
      status: "rotated" as const,
      id,
      userId: existing.userId,
      name,
    };
  },
});

/** Delete an API key; throws `KEY_NOT_FOUND` if it does not exist. */
const remove = mutation({
  args: { id: v.id("ApiKey") },
  returns: v.null(),
  handler: async (ctx, { id: keyId }) => {
    const key = await ctx.db.get("ApiKey", keyId);
    if (key === null) {
      throw new ConvexError({
        code: ErrorCode.KEY_NOT_FOUND,
        message: "API key not found",
        keyId,
      });
    }
    await ctx.db.delete("ApiKey", keyId);
    return null;
  },
});

export { remove };
