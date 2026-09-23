/**
 * TOTP management: the functions of the component that change or remove an
 * enrolled second factor. The enrollment itself is in `enrollment.ts`, and
 * the verification of a code at sign-in in `verification.ts`.
 *
 * The functions that weaken the second factor, `deleteTotp`, `disableTotp`
 * and `regenerateBackupCodes`, demand a current code (or a backup code) and
 * refuse without one: the component holds the rule that a stolen session
 * alone cannot turn the factor off or mint codes that stand in for it, thus
 * no caller can forget it. The one function that deletes the factor without
 * a code, `deleteUser`, is named for its purpose: the app deletes the user.
 *
 * @module
 */
import { mutation, MutationCtx } from "./_generated/server.ts";
import { Infer, v } from "convex/values";
import {
  CodeKind,
  codeKind,
  deleteTotpUserError,
  SecondFactorUserError,
  secondFactorUserError,
} from "./validation.ts";
import { checkSecondFactor } from "./verification.ts";
import {
  activeSecrets,
  backupCodesByUserId,
  pendingSecret,
  replaceBackupCodes,
} from "./helpers.ts";

const regenerateBackupCodesResult = v.union(
  v.object({
    success: v.literal(true),
    // The new backup codes, in the form the user sees them. This is the only
    // time the component returns them: it stores only their hashes.
    backupCodes: v.array(v.string()),
  }),
  v.object({ success: v.literal(false), userError: secondFactorUserError }),
);
type RegenerateBackupCodesResult = Infer<typeof regenerateBackupCodesResult>;

/**
 * Give a user a new set of backup codes. The previous set stops working.
 *
 * The user first proves they hold the second factor, with a current code of
 * one of their authenticators (`kind: "totp"`) or one of the old backup codes
 * (`kind: "backup"`): backup codes stand in for the authenticator at sign-in,
 * thus a stolen session alone must not mint a set. The check is the one of
 * `verifyCode` and `verifyBackupCode`, rate limit included, and a wrong code
 * returns its `INVALID_CODE` or `RATE_LIMITED`. `NOT_ENROLLED` is for a user
 * with no active secret: backup codes exist only for a user who has TOTP
 * enabled.
 *
 * The backup code that proved the factor is spent with the rest of the old
 * set.
 */
export const regenerateBackupCodes = mutation({
  args: { userId: v.string(), code: v.string(), kind: codeKind },
  returns: regenerateBackupCodesResult,
  handler: async (
    ctx,
    { userId, code, kind },
  ): Promise<RegenerateBackupCodesResult> => {
    const proven = await proveSecondFactor(ctx, userId, code, kind);
    if (!proven.success) {
      return proven;
    }
    const backupCodes = await replaceBackupCodes(ctx, userId);
    return { success: true, backupCodes };
  },
});

const deleteTotpResult = v.union(
  v.object({ success: v.literal(true) }),
  v.object({ success: v.literal(false), userError: deleteTotpUserError }),
);
type DeleteTotpResult = Infer<typeof deleteTotpResult>;

/**
 * Delete one authenticator of a user: the active secret `totpId` (from
 * `listTotps`, or the result of `confirmTotp`). Deleting the last one turns
 * TOTP off, and the backup codes go with it: they stand in for an
 * authenticator, and exist only while the user has one.
 *
 * The user first proves they hold the second factor, with a current code
 * from any of their authenticators (the one being deleted or another) or a
 * backup code, under the rate limit of `verifyCode`, so that a stolen session
 * alone cannot weaken the account. `TOTP_NOT_FOUND` is for an id that names
 * no active secret of the user, and is checked before the code, which is
 * thus not spent on it. `NOT_ENROLLED` is for a user with no active secret.
 */
export const deleteTotp = mutation({
  args: {
    userId: v.string(),
    totpId: v.string(),
    code: v.string(),
    kind: codeKind,
  },
  returns: deleteTotpResult,
  handler: async (
    ctx,
    { userId, totpId, code, kind },
  ): Promise<DeleteTotpResult> => {
    const active = await activeSecrets(ctx, userId);
    if (active.length === 0) {
      return { success: false, userError: { error: "NOT_ENROLLED" } };
    }
    const target = active.find((row) => row._id === totpId);
    if (target === undefined) {
      return { success: false, userError: { error: "TOTP_NOT_FOUND" } };
    }
    const proven = await checkSecondFactor(ctx, userId, active, code, kind);
    if (!proven.success) {
      return proven;
    }
    await ctx.db.delete("totpSecrets", target._id);
    if (active.length === 1) {
      await deleteBackupCodes(ctx, userId);
    }
    return { success: true };
  },
});

const disableTotpResult = v.union(
  v.object({ success: v.literal(true) }),
  v.object({ success: v.literal(false), userError: secondFactorUserError }),
);
type DisableTotpResult = Infer<typeof disableTotpResult>;

/**
 * Turn TOTP off for a user: delete every active secret, the pending secret
 * and the backup codes.
 *
 * As for `deleteTotp`, the user first proves they hold the second factor
 * with a current code or a backup code, under the same rate limit, so that a
 * stolen session alone cannot weaken the account. `NOT_ENROLLED` is for a
 * user with no active secret, who has nothing to turn off: a pending
 * enrollment grants nothing, and the next `createTotp` replaces it. The app
 * deletes a user, with everything the component holds for them, through
 * `deleteUser`.
 */
export const disableTotp = mutation({
  args: { userId: v.string(), code: v.string(), kind: codeKind },
  returns: disableTotpResult,
  handler: async (ctx, { userId, code, kind }): Promise<DisableTotpResult> => {
    const proven = await proveSecondFactor(ctx, userId, code, kind);
    if (!proven.success) {
      return proven;
    }
    await deleteAllTotpData(ctx, userId);
    return { success: true };
  },
});

/**
 * Check that a user with an active secret holds the second factor, with
 * `checkSecondFactor` of `verification.ts`, before a change to it. A code
 * from any active secret proves it. A user with no active secret has no code
 * to give: `NOT_ENROLLED`.
 */
async function proveSecondFactor(
  ctx: MutationCtx,
  userId: string,
  code: string,
  kind: CodeKind,
): Promise<
  { success: true } | { success: false; userError: SecondFactorUserError }
> {
  const active = await activeSecrets(ctx, userId);
  if (active.length === 0) {
    return { success: false, userError: { error: "NOT_ENROLLED" } };
  }
  return await checkSecondFactor(ctx, userId, active, code, kind);
}

/**
 * Delete all data the component holds for a user: the active secrets, the
 * pending secret and the backup codes.
 *
 * The app calls this function when it deletes a user permanently. It asks
 * for no proof that the caller holds the second factor, thus it is for the
 * app's own cleanup and not for a settings page a signed-in user reaches:
 * there, the user turns the factor off with `disableTotp` (or deletes their
 * authenticators with `deleteTotp`), which demands a current code first.
 *
 * The function is idempotent, thus it is safe to call for a user who never
 * enrolled.
 */
export const deleteUser = mutation({
  args: { userId: v.string() },
  returns: v.null(),
  handler: async (ctx, { userId }): Promise<null> => {
    await deleteAllTotpData(ctx, userId);
    return null;
  },
});

/**
 * Delete every row of the user: the active secrets, the pending secret and
 * the backup codes.
 */
async function deleteAllTotpData(
  ctx: MutationCtx,
  userId: string,
): Promise<void> {
  const [active, pending] = await Promise.all([
    activeSecrets(ctx, userId),
    pendingSecret(ctx, userId),
  ]);
  for (const row of pending === null ? active : [...active, pending]) {
    await ctx.db.delete("totpSecrets", row._id);
  }
  await deleteBackupCodes(ctx, userId);
}

async function deleteBackupCodes(
  ctx: MutationCtx,
  userId: string,
): Promise<void> {
  for (const row of await backupCodesByUserId(ctx, userId)) {
    await ctx.db.delete("backupCodes", row._id);
  }
}
