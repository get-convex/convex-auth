import { mutation, QueryCtx } from "./_generated/server";
import { Doc } from "./_generated/dataModel";
import { components } from "./_generated/api";
import { v } from "convex/values";
import { RateLimiter, MINUTE } from "@convex-dev/rate-limiter";
import {
  hashPassword,
  verifyPassword as verifyPasswordHash,
} from "./argon2.js";
import { assertValidPassword, normalizePassword } from "./validation.js";

// Throttle password verification per user id: a token bucket that refills at 1
// attempt/minute up to a burst of 5. Applies to `verifyPassword` only — setting
// a password is gated by the app's own auth, not brute-forceable.
const rateLimiter = new RateLimiter(components.rateLimiter, {
  verifyPassword: { kind: "token bucket", rate: 1, period: MINUTE, capacity: 5 },
});

/** Look up the stored password row for a user id. */
function passwordByUserId(
  ctx: QueryCtx,
  userId: string,
): Promise<Doc<"passwords"> | null> {
  return ctx.db
    .query("passwords")
    .withIndex("by_userId", (q) => q.eq("userId", userId))
    .unique();
}

/**
 * Set (or replace) a user's password. Validates and NFC-normalizes the password,
 * hashes it with argon2id, then upserts the row keyed by `userId`. Idempotent in
 * shape: calling it again for the same user replaces the stored hash.
 */
export const setPassword = mutation({
  args: { userId: v.string(), password: v.string() },
  returns: v.null(),
  handler: async (ctx, { userId, password }) => {
    assertValidPassword(password);
    const passwordHash = await hashPassword(normalizePassword(password));
    const existing = await passwordByUserId(ctx, userId);
    if (existing !== null) {
      await ctx.db.patch(existing._id, { passwordHash });
    } else {
      await ctx.db.insert("passwords", { userId, passwordHash });
    }
    return null;
  },
});

/**
 * Verify a user's password. A mutation rather than a query — this keeps it on
 * the (serialized, timing-attack-resistant) write path and leaves room to
 * rehash-on-verify later. Rate-limited per user id; throws when the bucket is
 * empty. Returns `false` for an unknown user or a wrong password.
 *
 * Future: when the stored PHC string's parameters fall behind the current
 * policy, rehash the password here and patch the row — the PHC storage makes
 * that a drop-in change.
 */
export const verifyPassword = mutation({
  args: { userId: v.string(), password: v.string() },
  returns: v.boolean(),
  handler: async (ctx, { userId, password }) => {
    await rateLimiter.limit(ctx, "verifyPassword", {
      key: userId,
      throws: true,
    });
    const row = await passwordByUserId(ctx, userId);
    if (row === null) {
      return false;
    }
    return await verifyPasswordHash(normalizePassword(password), row.passwordHash);
  },
});
