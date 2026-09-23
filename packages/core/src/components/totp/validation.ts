import { Infer, v } from "convex/values";

/**
 * The user-facing errors for `verifyCode` and `verifyBackupCode`. An
 * application can show these errors to the end user. The `error` field is a
 * machine-readable code and the discriminant of the union. Declared here so
 * that setup recipes can reuse the validator in their own return validators.
 */
export const verifyCodeUserError = v.union(
  // The code is not the current code, is malformed, or has been used already.
  // One error for the three cases: a distinct error for a used code would tell
  // an attacker that a guess was right a moment ago.
  v.object({ error: v.literal("INVALID_CODE") }),
  v.object({ error: v.literal("RATE_LIMITED"), retryAfterMs: v.number() }),
);
export type VerifyCodeUserError = Infer<typeof verifyCodeUserError>;

/**
 * What a `code` is: a code from the authenticator app (`"totp"`), or one of
 * the user's backup codes (`"backup"`).
 */
export const codeKind = v.union(v.literal("totp"), v.literal("backup"));
export type CodeKind = Infer<typeof codeKind>;

/**
 * The user-facing errors of the functions that change the second factor of a
 * user and demand a code first (`disableTotp`, `regenerateBackupCodes`): the
 * errors of the code, or `NOT_ENROLLED` when the user has no active secret and
 * thus no code to give.
 */
export const secondFactorUserError = v.union(
  verifyCodeUserError,
  v.object({ error: v.literal("NOT_ENROLLED") }),
);
export type SecondFactorUserError = Infer<typeof secondFactorUserError>;

/**
 * The user-facing errors for `confirmTotp` when the user has no active
 * authenticator, as in a setup recipe that gives each user a single one. A
 * recipe that lets a user add authenticators reuses
 * {@link confirmMultiTotpUserError} instead.
 */
export const confirmSingleTotpUserError = v.union(
  // The code is not the code that the pending secret gives at this moment.
  // Usually the user typed it wrong, or the clock of their device is off.
  v.object({ error: v.literal("INVALID_CODE") }),
  // The user has no pending secret: `createTotp` was not called, the
  // enrollment was confirmed already, or it expired.
  v.object({ error: v.literal("NO_PENDING_ENROLLMENT") }),
);
export type ConfirmSingleTotpUserError = Infer<
  typeof confirmSingleTotpUserError
>;

/**
 * The user-facing errors for `confirmTotp`: the errors of
 * {@link confirmSingleTotpUserError}, and `TOO_MANY_TOTPS` for a user who
 * already has as many authenticators as the component allows.
 */
export const confirmMultiTotpUserError = v.union(
  confirmSingleTotpUserError,
  // The user has `MAX_TOTPS_PER_USER` active secrets. The user deletes one
  // first.
  v.object({ error: v.literal("TOO_MANY_TOTPS") }),
);
export type ConfirmMultiTotpUserError = Infer<typeof confirmMultiTotpUserError>;

/**
 * The user-facing errors for `deleteTotp`: the errors of the code, and
 * `TOTP_NOT_FOUND` when the id names no active authenticator of the user.
 */
export const deleteTotpUserError = v.union(
  secondFactorUserError,
  // The id is malformed, names a secret of a different user, or names no
  // active secret (a pending one, or one that is gone already).
  v.object({ error: v.literal("TOTP_NOT_FOUND") }),
);
export type DeleteTotpUserError = Infer<typeof deleteTotpUserError>;

/**
 * Normalize a TOTP code as the user typed it. Authenticator apps show the
 * code with a space in the middle (`123 456`), and a user copies that space.
 */
export function normalizeCode(code: string): string {
  return code.replace(/\s/g, "");
}

/**
 * Tell if a normalized code has the form of a TOTP code with this many digits.
 */
export function isWellFormedCode(code: string, digits: number): boolean {
  return new RegExp(`^[0-9]{${digits}}$`).test(code);
}
