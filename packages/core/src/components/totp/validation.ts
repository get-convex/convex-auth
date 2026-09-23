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
 * user and demand a code first (`deleteTotp`, `regenerateBackupCodes`): the
 * errors of the code, or `NOT_ENROLLED` when the user has no active secret and
 * thus no code to give.
 */
export const secondFactorUserError = v.union(
  verifyCodeUserError,
  v.object({ error: v.literal("NOT_ENROLLED") }),
);
export type SecondFactorUserError = Infer<typeof secondFactorUserError>;

/**
 * The user-facing errors for `confirmTotp`.
 */
export const confirmTotpUserError = v.union(
  // The code is not the code that the pending secret gives at this moment.
  // Usually the user typed it wrong, or the clock of their device is off.
  v.object({ error: v.literal("INVALID_CODE") }),
  // The user has no pending secret: `createTotp` was not called, the
  // enrollment was confirmed already, or it expired.
  v.object({ error: v.literal("NO_PENDING_ENROLLMENT") }),
);
export type ConfirmTotpUserError = Infer<typeof confirmTotpUserError>;

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
