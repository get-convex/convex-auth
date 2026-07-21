import type { FunctionReference, FunctionReturnType, OptionalRestArgs } from "convex/server";

import type { ConvexAuthConfig } from "./types";

const DEFAULT_MAX_SIGN_IN_ATTEMPTS_PER_HOUR = 10;

/**
 * Minimal context the rate-limit helpers depend on. The component API is
 * threaded in via the explicit `config` argument, so only `runQuery` /
 * `runMutation` are required. Typed with the narrowest call shape the helpers
 * actually use so both mutation handlers (credentials sign-in) and action
 * handlers (the TOTP ceremony) satisfy it, despite their differing
 * `runQuery`/`runMutation` option overloads.
 *
 * @internal
 */
export type SignInLimitCtx = {
  runQuery: <Query extends FunctionReference<"query", "public" | "internal">>(
    query: Query,
    ...args: OptionalRestArgs<Query>
  ) => Promise<FunctionReturnType<Query>>;
  runMutation: <Mutation extends FunctionReference<"mutation", "public" | "internal">>(
    mutation: Mutation,
    ...args: OptionalRestArgs<Mutation>
  ) => Promise<FunctionReturnType<Mutation>>;
};

/**
 * Minimal config shape the rate-limit helpers depend on. Both
 * {@link ConvexAuthConfig} and `ConvexAuthMaterializedConfig` satisfy it, so
 * the helpers work from mutation and action handlers alike.
 *
 * @internal
 */
export type SignInLimitConfig = Pick<ConvexAuthConfig, "component" | "signIn">;

function maxAttempts(config: SignInLimitConfig) {
  return config.signIn?.maxFailedAttemptsPerHour ?? DEFAULT_MAX_SIGN_IN_ATTEMPTS_PER_HOUR;
}

/**
 * Check whether the given identifier is currently rate-limited.
 *
 * @internal
 */
export async function isSignInRateLimited(
  ctx: SignInLimitCtx,
  identifier: string,
  config: SignInLimitConfig,
): Promise<boolean> {
  const { ok } = await ctx.runQuery(config.component.limits.signInCheck, {
    identifier,
    maxAttemptsPerHour: maxAttempts(config),
  });
  return !ok;
}

/**
 * Record a failed sign-in attempt for the given identifier.
 *
 * @internal
 */
export async function recordFailedSignIn(
  ctx: SignInLimitCtx,
  identifier: string,
  config: SignInLimitConfig,
): Promise<void> {
  await ctx.runMutation(config.component.limits.signInRecord, {
    identifier,
    maxAttemptsPerHour: maxAttempts(config),
  });
}

/**
 * Reserve one sign-in attempt up front, consuming a token as part of the same
 * atomic component mutation. Returns `true` when the caller is **blocked** (the
 * bucket was already empty, so no token was taken) and `false` when a token was
 * successfully consumed and the caller may proceed.
 *
 * Unlike {@link isSignInRateLimited} — a non-consuming peek — this closes the
 * check-then-record TOCTOU that lets N concurrent guesses in an **action**
 * (TOTP / passkey verify) all pass a `check()` before any `limit()` commits.
 * Reserving before the verification makes each attempt consume a token
 * atomically, so the per-hour cap bounds *attempts*, not merely logged failures.
 *
 * A single normal attempt consumes exactly one token; callers refund it on a
 * successful verification via {@link resetSignInRateLimit}. On a failed
 * verification the caller must NOT also call {@link recordFailedSignIn} — the
 * reservation already counted the attempt.
 *
 * @internal
 */
export async function reserveSignInAttempt(
  ctx: SignInLimitCtx,
  identifier: string,
  config: SignInLimitConfig,
): Promise<boolean> {
  const { ok } = await ctx.runMutation(config.component.limits.signInRecord, {
    identifier,
    maxAttemptsPerHour: maxAttempts(config),
  });
  return !ok;
}

/**
 * Reset the rate limit for the given identifier.
 *
 * @internal
 */
export async function resetSignInRateLimit(
  ctx: SignInLimitCtx,
  identifier: string,
  config: SignInLimitConfig,
): Promise<void> {
  await ctx.runMutation(config.component.limits.signInReset, { identifier });
}
