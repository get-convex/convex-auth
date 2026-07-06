import { Infer, v } from "convex/values";

// Password requirements, following the NIST guidance summarized at
// https://auth.pilcrowonpaper.com/passwords: 10–100 characters, any printable
// Unicode, no leading/trailing whitespace.

export const MIN_PASSWORD_LENGTH = 10;
export const MAX_PASSWORD_LENGTH = 100;

/**
 * A user-facing error describing why a password was rejected. Safe to surface
 * to the end user. The `error` field is both a machine-readable code and the
 * discriminant of the union.
 */
export const setPasswordUserError = v.union(
  v.object({
    error: v.literal("PASSWORD_TOO_SHORT"),
    minimumLength: v.number(),
  }),
  v.object({
    error: v.literal("PASSWORD_TOO_LONG"),
    maximumLength: v.number(),
  }),
  v.object({ error: v.literal("PASSWORD_HAS_SURROUNDING_WHITESPACE") }),
);
export type SetPasswordUserError = Infer<typeof setPasswordUserError>;

/**
 * Validate a password against the requirements. Returns a `SetPasswordUserError`
 * describing the first violation, or `null` when the password is valid.
 */
export function validatePassword(
  password: string,
): SetPasswordUserError | null {
  // Length is measured in Unicode code points (`[...password].length`) rather
  // than UTF-16 units, so an astral character (e.g. an emoji) counts as one, per
  // NIST's "1 character" intent.
  const length = [...password].length;

  if (length < MIN_PASSWORD_LENGTH) {
    return { error: "PASSWORD_TOO_SHORT", minimumLength: MIN_PASSWORD_LENGTH };
  }
  if (length > MAX_PASSWORD_LENGTH) {
    return { error: "PASSWORD_TOO_LONG", maximumLength: MAX_PASSWORD_LENGTH };
  }
  // Reject leading/trailing whitespace. `\s` with the `u` flag matches Unicode
  // whitespace (e.g. non-breaking space, ideographic space), which a plain
  // `password.trim()` comparison would miss.
  if (/^\s|\s$/u.test(password)) {
    return { error: "PASSWORD_HAS_SURROUNDING_WHITESPACE" };
  }
  return null;
}

// Normalize to NFC before hashing or verifying so that two inputs that a user
// perceives as identical but that arrive in different Unicode normalization
// forms hash the same.
export function normalizePassword(password: string): string {
  return password.normalize("NFC");
}
