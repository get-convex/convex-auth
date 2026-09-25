/**
 * TOTP verification at sign-in: the functions of the component that check a
 * code from an enrolled user, the throttle that guards them, and the record
 * that tells the auth core which sign-in attempts verified a code. The same
 * check, as {@link checkSecondFactor}, is what the management functions of
 * `management.ts` demand before they weaken the second factor.
 *
 * @module
 */
import { mutation, MutationCtx, query, QueryCtx } from "./_generated/server.ts";
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

// How long the component remembers that a sign-in attempt verified a code.
// The auth core never reuses an attempt id, thus a record that outlives its
// attempt satisfies nothing, and this only bounds the size of the table. It is
// well above the auth core's default attempt lifetime of 10 minutes; an app
// that configures a longer lifetime than this makes a slow user verify a code
// twice, which is an inconvenience and not a security issue.
export const SIGN_IN_VERIFICATION_TTL_MS = 60 * 60 * 1000; // 1 hour
// How many stale verification rows one successful verification sweeps away.
const STALE_VERIFICATIONS_PRUNED_PER_VERIFY = 10;

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
 * When the code is for a pending sign-in, pass the attempt's `attemptId`
 * (from the auth core): on success the component records that this attempt
 * verified a code, which `checkSignIn` reads back. Without an attempt id the
 * function only verifies, for a re-authentication before a sensitive action,
 * say.
 *
 * The function throws when the user has no active secret: the app checks
 * `getStatus` before it asks for a code, thus this is a programming error
 * and not a user-facing condition.
 */
export const verifyCode = mutation({
  args: {
    userId: v.string(),
    code: v.string(),
    attemptId: v.optional(v.string()),
  },
  returns: verifyCodeResult,
  handler: async (
    ctx,
    { userId, code, attemptId },
  ): Promise<VerifyCodeResult> => {
    const active = await requireActiveSecret(ctx, userId);
    const checked = await checkSecondFactor(ctx, active, code, "totp");
    if (!checked.success) {
      return checked;
    }
    if (attemptId !== undefined) {
      await recordSignInVerification(ctx, userId, attemptId);
    }
    return { success: true };
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
 * As for `verifyCode`, pass the `attemptId` of a pending sign-in to record
 * that the attempt verified a code.
 *
 * The function throws when the user has no active secret, as `verifyCode`
 * does.
 */
export const verifyBackupCode = mutation({
  args: {
    userId: v.string(),
    code: v.string(),
    attemptId: v.optional(v.string()),
  },
  returns: verifyBackupCodeResult,
  handler: async (
    ctx,
    { userId, code, attemptId },
  ): Promise<VerifyBackupCodeResult> => {
    const active = await requireActiveSecret(ctx, userId);
    const checked = await checkSecondFactor(ctx, active, code, "backup");
    if (!checked.success) {
      return checked;
    }
    if (attemptId !== undefined) {
      await recordSignInVerification(ctx, userId, attemptId);
    }
    const remaining = await backupCodesByUserId(ctx, userId);
    return { success: true, remainingBackupCodes: remaining.length };
  },
});

/**
 * The sign-in check of this component, for the auth core: whether a pending
 * sign-in attempt of a user has settled its TOTP.
 *
 * `false` when the user has an active secret and the attempt has not
 * verified a code (with `verifyCode` or `verifyBackupCode`), `true`
 * otherwise: a user who is not enrolled owes nothing, and neither does an
 * attempt that verified a code. A pending enrollment that the user has not
 * confirmed does not count as enrolled.
 *
 * A provider that wants a second factor from enrolled users parks a sign-in
 * on this function, under the name `totpSignInCheck` (in `requirement.ts`)
 * pairs it with; the core runs it, with the attempt's subject, each time the
 * client continues the sign-in, and reports the name while it returns
 * `false`. The
 * answer is trustworthy because only this component writes the verification
 * record, and only after a code checked out: no code outside the component
 * can mark an attempt as verified. Both the attempt id and the user id must
 * match, thus a verification of one user never satisfies the attempt of
 * another.
 */
export const checkSignIn = query({
  args: { userId: v.string(), attemptId: v.string() },
  returns: v.boolean(),
  handler: async (ctx, { userId, attemptId }): Promise<boolean> => {
    const active = await secretByStatus(ctx, userId, "active");
    if (active === null) return true;
    const verification = await signInVerificationByAttemptId(ctx, attemptId);
    return verification !== null && verification.userId === userId;
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
 * (see `rateLimiter` above), for the verification mutations of this module
 * and for the functions of `management.ts` that change the second factor.
 *
 * A right TOTP code marks its time step used, thus it cannot be replayed. A
 * right backup code is deleted, thus it works once. A wrong code of either
 * kind takes one token from the bucket of the user.
 */
export async function checkSecondFactor(
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

/**
 * Record that a sign-in attempt verified a code. A second verification for
 * the same attempt (a TOTP code after a backup code, say) changes nothing.
 *
 * Each record also sweeps a bounded number of stale records, thus a
 * deployment that keeps verifying codes keeps this table trimmed with no
 * background job.
 */
async function recordSignInVerification(
  ctx: MutationCtx,
  userId: string,
  attemptId: string,
): Promise<void> {
  const stale = await ctx.db
    .query("signInVerifications")
    .withIndex("by_creation_time", (q) =>
      q.lt("_creationTime", Date.now() - SIGN_IN_VERIFICATION_TTL_MS),
    )
    .take(STALE_VERIFICATIONS_PRUNED_PER_VERIFY);
  for (const row of stale) {
    await ctx.db.delete("signInVerifications", row._id);
  }

  const existing = await signInVerificationByAttemptId(ctx, attemptId);
  if (existing === null) {
    await ctx.db.insert("signInVerifications", { attemptId, userId });
  }
}

function signInVerificationByAttemptId(
  ctx: QueryCtx,
  attemptId: string,
): Promise<Doc<"signInVerifications"> | null> {
  return ctx.db
    .query("signInVerifications")
    .withIndex("by_attemptId", (q) => q.eq("attemptId", attemptId))
    .unique();
}
