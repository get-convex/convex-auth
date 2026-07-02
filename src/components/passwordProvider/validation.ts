import { ConvexError } from "convex/values";

// Password requirements, following the NIST guidance summarized at
// https://auth.pilcrowonpaper.com/passwords: 10–100 characters, any printable
// Unicode, no leading/trailing whitespace. No composition rules (no forced
// mix of character classes) and no Have-I-Been-Pwned check.
//
// Length is measured in Unicode code points (`[...password].length`) rather
// than UTF-16 units, so an astral character (e.g. an emoji) counts as one, per
// NIST's "1 character" intent.
export function assertValidPassword(password: string): void {
  const length = [...password].length;
  if (length < 10 || length > 100) {
    throw new ConvexError("Password must be between 10 and 100 characters.");
  }
  // Reject leading/trailing whitespace. `\s` with the `u` flag matches Unicode
  // whitespace (e.g. non-breaking space, ideographic space), which a plain
  // `password.trim()` comparison would miss.
  if (/^\s|\s$/u.test(password)) {
    throw new ConvexError("Password must not start or end with whitespace.");
  }
}

// Normalize to NFC before hashing or verifying so that two inputs that a user
// perceives as identical but that arrive in different Unicode normalization
// forms (common with accented characters entered on different platforms) hash
// the same. Applied by both mutations so a password set on one device verifies
// on another.
export function normalizePassword(password: string): string {
  return password.normalize("NFC");
}
