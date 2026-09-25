/**
 * TOTP verification at sign-in: the functions of the component that check a
 * code from an enrolled user, and the throttle that guards them.
 *
 * @module
 */
import { mutation, MutationCtx } from "./_generated/server.ts";
import { Doc } from "./_generated/dataModel.ts";
import { components } from "./_generated/api.ts";
import { Infer, v } from "convex/values";
import { RateLimiter, MINUTE } from "@convex-dev/rate-limiter";
import { hashBackupCode } from "./backupCodes.ts";
import { CodeKind, verifyCodeUserError } from "./validation.ts";
import { backupCodesByUserId, matchCode, secretByStatus } from "./helpers.ts";

// Throttle for wrong codes, per user id. `verifyCode` and `verifyBackupCode`
// share one bucket. A verification only takes a token from the bucket when the
// code is wrong.
//
// A 6-digit code with the ±1 step window of `matchCode` gives an attacker 3
// valid guesses in a million per attempt. A token bucket of 5 that refills at
// one attempt every 5 minutes caps a persistent attacker at about 105k guesses
// a year, thus about 0.3 expected successes a year against one account, and
// only after the first factor has been defeated. A legitimate user gets 5
// tries at once, which covers a typo or a slow hand, and their right codes
// (a sign-in, then turning the second factor off, say) never use up a try.
//
// As with the password provider, the limit is keyed on the user id and not on
// an IP address (see OWASP): an IP limit hurts legitimate users behind a shared
// address and is bypassed with proxies. A malicious user can exhaust the bucket
// of a legitimate user, who then waits at most 5 minutes for one more try.
const rateLimiter = new RateLimiter(components.rateLimiter, {
  verifyCode: {
    kind: "token bucket",
    rate: 1,
    period: 5 * MINUTE,
    capacity: 5,
  },
});

const verifyCodeResult = v.union(
  v.object({ success: v.literal(true) }),
  v.object({ success: v.literal(false), userError: verifyCodeUserError }),
);
type VerifyCodeResult = Infer<typeof verifyCodeResult>;

/**
 * Verify a TOTP code from the authenticator of a user.
 *
 * The function accepts the code of the current time step and, to tolerate
 * clock drift, the codes of the previous and the next step. A code is
 * accepted once: a second call with the same code, or with the code of an
 * earlier step, returns `INVALID_CODE`.
 *
 * This enforces a rate limit on wrong codes (see `rateLimiter` above): a
 * right code is never charged, and an empty bucket refuses any code.
 *
 * The function throws when the user has no active secret: the app checks
 * `getStatus` before it asks for a code, thus this is a programming error
 * and not a user-facing condition.
 */
export const verifyCode = mutation({
  args: { userId: v.string(), code: v.string() },
  returns: verifyCodeResult,
  handler: async (ctx, { userId, code }): Promise<VerifyCodeResult> => {
    const active = await requireActiveSecret(ctx, userId);
    return await checkSecondFactor(ctx, active, code, "totp");
  },
});

const verifyBackupCodeResult = v.union(
  v.object({
    success: v.literal(true),
    // The number of backup codes the user has left. An app warns the user
    // when this gets low, and offers `regenerateBackupCodes`.
    remainingBackupCodes: v.number(),
  }),
  v.object({ success: v.literal(false), userError: verifyCodeUserError }),
);
type VerifyBackupCodeResult = Infer<typeof verifyBackupCodeResult>;

/**
 * Verify a backup code of a user, in place of a TOTP code.
 *
 * A backup code works once: the function deletes it on success. The
 * comparison ignores the case of the code, the hyphen and any spaces.
 *
 * This enforces the same rate limit as `verifyCode`.
 *
 * The function throws when the user has no active secret, as `verifyCode`
 * does.
 */
export const verifyBackupCode = mutation({
  args: { userId: v.string(), code: v.string() },
  returns: verifyBackupCodeResult,
  handler: async (ctx, { userId, code }): Promise<VerifyBackupCodeResult> => {
    const active = await requireActiveSecret(ctx, userId);
    const checked = await checkSecondFactor(ctx, active, code, "backup");
    if (!checked.success) {
      return checked;
    }
    const remaining = await backupCodesByUserId(ctx, userId);
    return { success: true, remainingBackupCodes: remaining.length };
  },
});

/**
 * The active secret of the user, for the verification mutations, which throw
 * when there is none: the flow that asks for a code knows that the user is
 * enrolled, thus a missing secret is a programming error.
 */
async function requireActiveSecret(
  ctx: MutationCtx,
  userId: string,
): Promise<Doc<"totpSecrets">> {
  const active = await secretByStatus(ctx, userId, "active");
  if (active === null) {
    throw new Error(`No active TOTP secret for userId ${userId}.`);
  }
  return active;
}

/**
 * Check that `code` proves the user holds the second factor: a current code
 * of their active secret, or one of their backup codes, as `kind` says. This
 * is the one place a code is checked, under the rate limit on wrong codes
 * (see `rateLimiter` above), for the verification mutations of this module.
 *
 * A right TOTP code marks its time step used, thus it cannot be replayed. A
 * right backup code is deleted, thus it works once. A wrong code of either
 * kind takes one token from the bucket of the user.
 */
async function checkSecondFactor(
  ctx: MutationCtx,
  active: Doc<"totpSecrets">,
  code: string,
  kind: CodeKind,
): Promise<VerifyCodeResult> {
  const rateLimited = await checkVerificationLimit(ctx, active.userId);
  if (rateLimited !== null) {
    return rateLimited;
  }
  return kind === "backup"
    ? await checkBackupCode(ctx, active.userId, code)
    : await checkTotpCode(ctx, active, code);
}

async function checkTotpCode(
  ctx: MutationCtx,
  active: Doc<"totpSecrets">,
  code: string,
): Promise<VerifyCodeResult> {
  const matchedCounter = await matchCode(active, code, Date.now());
  if (
    matchedCounter === null ||
    (active.lastUsedCounter !== undefined &&
      matchedCounter <= active.lastUsedCounter)
  ) {
    return await chargeWrongCode(ctx, active.userId);
  }
  await ctx.db.patch("totpSecrets", active._id, {
    lastUsedCounter: matchedCounter,
  });
  return { success: true };
}

async function checkBackupCode(
  ctx: MutationCtx,
  userId: string,
  code: string,
): Promise<VerifyCodeResult> {
  // The hash lookup, and not a comparison of the hashes in JavaScript, is
  // what keeps the check independent of the content of the code.
  const codeHash = await hashBackupCode(code);
  const row = await ctx.db
    .query("backupCodes")
    .withIndex("by_userId_codeHash", (q) =>
      q.eq("userId", userId).eq("codeHash", codeHash),
    )
    .unique();
  if (row === null) {
    return await chargeWrongCode(ctx, userId);
  }
  await ctx.db.delete("backupCodes", row._id);
  return { success: true };
}

/**
 * Take one token from the bucket of wrong codes for the user.
 *
 * Returns an `INVALID_CODE` result that can be passed along to the caller that
 * attempted to verify a code.
 */
async function chargeWrongCode(
  ctx: MutationCtx,
  userId: string,
): Promise<Extract<VerifyCodeResult, { success: false }>> {
  await rateLimiter.limit(ctx, "verifyCode", { key: userId });
  return { success: false, userError: { error: "INVALID_CODE" } };
}

/**
 * Check the bucket of wrong codes of the user, without taking from it. Return
 * the `RATE_LIMITED` result when the bucket is empty, `null` otherwise.
 *
 * Run this before the code is checked, and `chargeWrongCode` after a wrong
 * one. Mutations are serializable, thus concurrent guesses cannot slip between
 * the check and the charge: each wrong guess reads and writes the same bucket.
 */
async function checkVerificationLimit(
  ctx: MutationCtx,
  userId: string,
): Promise<Extract<VerifyCodeResult, { success: false }> | null> {
  const status = await rateLimiter.check(ctx, "verifyCode", { key: userId });
  if (status.ok) {
    return null;
  }
  return {
    success: false,
    userError: { error: "RATE_LIMITED", retryAfterMs: status.retryAfter },
  };
}
