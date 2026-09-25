import { Infer, v } from "convex/values";

/**
 * The user-facing errors for `confirmTotp`. An application can show these
 * errors to the end user. The `error` field is a machine-readable code and
 * the discriminant of the union. Declared here so that setup recipes can
 * reuse the validator in their own return validators.
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
