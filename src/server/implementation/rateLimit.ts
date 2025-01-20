import { ConvexAuthConfig } from "../index.js";
import { MutationCtx } from "./types.js";

const DEFAULT_MAX_SIGN_IN_ATTEMPTS_PER_HOUR = 10;

export async function isSignInRateLimited(
  ctx: MutationCtx,
  identifier: string,
  config: ConvexAuthConfig,
) {
  const state = await getRateLimitState(ctx, identifier, config);
  if (state === null) {
    return false;
  }
  return state.attempsLeft < 1;
}

export async function recordFailedSignIn(
  ctx: MutationCtx,
  identifier: string,
  config: ConvexAuthConfig,
) {
  const state = await getRateLimitState(ctx, identifier, config);
  if (state !== null) {
    await ctx.db.patch(state.limit._id, {
      attemptsLeft: state.attempsLeft - 1,
      lastAttemptTime: Date.now(),
    });
  } else {
    const maxAttempsPerHour = configuredMaxAttempsPerHour(config);
    await ctx.db.insert("authRateLimits", {
      identifier,
      attemptsLeft: maxAttempsPerHour - 1,
      lastAttemptTime: Date.now(),
    });
  }
}

export async function resetSignInRateLimit(
  ctx: MutationCtx,
  identifier: string,
) {
  const existingState = await ctx.db
    .query("authRateLimits")
    .withIndex("identifier", (q) => q.eq("identifier", identifier))
    .unique();
  if (existingState !== null) {
    await ctx.db.delete(existingState._id);
  }
}

async function getRateLimitState(
  ctx: MutationCtx,
  identifier: string,
  config: ConvexAuthConfig,
) {
  const now = Date.now();
  const maxAttempsPerHour = configuredMaxAttempsPerHour(config);
  const limit = await ctx.db
    .query("authRateLimits")
    .withIndex("identifier", (q) => q.eq("identifier", identifier))
    .unique();
  if (limit === null) {
    return null;
  }
  const elapsed = now - limit.lastAttemptTime;
  const maxAttempsPerMs = maxAttempsPerHour / (60 * 60 * 1000);
  const attempsLeft = Math.min(
    maxAttempsPerHour,
    limit.attemptsLeft + elapsed * maxAttempsPerMs,
  );
  return { limit, attempsLeft };
}

function configuredMaxAttempsPerHour(config: ConvexAuthConfig) {
  return (
    config.signIn?.maxFailedAttempsPerHour ??
    DEFAULT_MAX_SIGN_IN_ATTEMPTS_PER_HOUR
  );
}
