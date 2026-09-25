/**
 * TOTP management: the functions of the component that change or remove an
 * enrolled second factor. The enrollment itself is in `enrollment.ts`, and
 * the verification of a code at sign-in in `verification.ts`.
 *
 * The functions that weaken the second factor, `deleteTotp` and
 * `regenerateBackupCodes`, demand a current code (or a backup code) and
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
  SecondFactorUserError,
  secondFactorUserError,
} from "./validation.ts";
import { checkSecondFactor } from "./verification.ts";
import {
  backupCodesByUserId,
  replaceBackupCodes,
  secretByStatus,
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
 * their authenticator (`kind: "totp"`) or one of the old backup codes
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
  v.object({ success: v.literal(false), userError: secondFactorUserError }),
);
type DeleteTotpResult = Infer<typeof deleteTotpResult>;

/**
 * Turn TOTP off for a user: delete the active secret, the pending secret and
 * the backup codes.
 *
 * As for `regenerateBackupCodes`, the user first proves they hold the second
 * factor with a current code or a backup code, under the same rate limit, so
 * that a stolen session alone cannot weaken the account. `NOT_ENROLLED` is
 * for a user with no active secret, who has nothing to turn off: a pending
 * enrollment grants nothing, and the next `createTotp` replaces it. The app
 * deletes a user, with everything the component holds for them, through
 * `deleteUser`.
 */
export const deleteTotp = mutation({
  args: { userId: v.string(), code: v.string(), kind: codeKind },
  returns: deleteTotpResult,
  handler: async (ctx, { userId, code, kind }): Promise<DeleteTotpResult> => {
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
 * `checkSecondFactor` of `verification.ts`, before a change to it. A user
 * with no active secret has no code to give: `NOT_ENROLLED`.
 */
async function proveSecondFactor(
  ctx: MutationCtx,
  userId: string,
  code: string,
  kind: CodeKind,
): Promise<
  { success: true } | { success: false; userError: SecondFactorUserError }
> {
  const active = await secretByStatus(ctx, userId, "active");
  if (active === null) {
    return { success: false, userError: { error: "NOT_ENROLLED" } };
  }
  return await checkSecondFactor(ctx, active, code, kind);
}

/**
 * Delete all data the component holds for a user: the active secret, the
 * pending secret and the backup codes.
 *
 * The app calls this function when it deletes a user permanently. It asks
 * for no proof that the caller holds the second factor, thus it is for the
 * app's own cleanup and not for a settings page a signed-in user reaches:
 * there, the user turns the factor off with `deleteTotp`, which demands a
 * current code first.
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
 * Delete every row of the user: the active secret, the pending secret and
 * the backup codes.
 */
async function deleteAllTotpData(
  ctx: MutationCtx,
  userId: string,
): Promise<void> {
  const [active, pending, backupCodes] = await Promise.all([
    secretByStatus(ctx, userId, "active"),
    secretByStatus(ctx, userId, "pending"),
    backupCodesByUserId(ctx, userId),
  ]);
  for (const row of [active, pending]) {
    if (row !== null) {
      await ctx.db.delete("totpSecrets", row._id);
    }
  }
  for (const row of backupCodes) {
    await ctx.db.delete("backupCodes", row._id);
  }
}
