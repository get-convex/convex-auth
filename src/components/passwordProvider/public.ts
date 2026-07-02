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

// Throttle for password verification attempts.
//
// This implementation follows Pilcrow’s recommendations (https://auth.pilcrowonpaper.com/passwords).
//
// In particular:
// - The maximum rate is 1 attempt per minute, which caps attackers at ~500k attempts per year.
// - We use a token bucket with a capacity of 5, so that legitimate users
//   shouldn’t be affected by the rate limit in most cases.
// - The rate limit is for each particular user ID. We do not base the rate limits on IP addresses,
//   following recommendations from OWASP, because IP rate limits can hurt legitimate users
//   and can trivially be bypassed by attackers using proxies.
//
// Note that the rate limit can be abused by malicious users to prevent a legitimate user
// from logging in. Applications should allow users to log in through other means,
// for instance through the “reset password” flow, in order to avoid this issue.
const rateLimiter = new RateLimiter(components.rateLimiter, {
  verifyPassword: {
    kind: "token bucket",
    rate: 1,
    period: MINUTE,
    capacity: 5,
  },
});

/**
 * Set (or replace) a user's password.
 *
 * This can be used both when creating a new user (will create a row),
 * or to update the password for an existing user (will update the existing row).
 */
export const setPassword = mutation({
  args: { userId: v.string(), password: v.string() },
  returns: v.null(),
  handler: async (ctx, { userId, password }) => {
    assertValidPassword(password);
    const passwordHashPHC = await hashPassword(normalizePassword(password));
    const existing = await passwordByUserId(ctx, userId);
    if (existing !== null) {
      await ctx.db.patch("passwords", existing._id, { passwordHashPHC });
    } else {
      await ctx.db.insert("passwords", { userId, passwordHashPHC });
    }
    return null;
  },
});

/**
 * Verify a user's password.
 *
 * This enforces a rate limit (see `rateLimiter` above).
 *
 * In the future, this will also automatically update password hashes
 * that do not match the latest security recommendations.
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
    return await verifyPasswordHash(
      normalizePassword(password),
      row.passwordHashPHC,
    );
  },
});

function passwordByUserId(
  ctx: QueryCtx,
  userId: string,
): Promise<Doc<"passwords"> | null> {
  return ctx.db
    .query("passwords")
    .withIndex("by_userId", (q) => q.eq("userId", userId))
    .unique();
}
