import { sha256Hex } from "../../lib/crypto.ts";

/**
 * Backup codes: single-use codes that stand in for a TOTP code when the user
 * has no access to their authenticator.
 *
 * These functions have no Convex dependency. The component's public functions
 * call them.
 */

// The number of codes a user gets, and the number of characters in each code.
export const BACKUP_CODE_COUNT = 10;
export const BACKUP_CODE_LENGTH = 10;

const BACKUP_CODE_SPLIT_POINT = Math.floor(BACKUP_CODE_LENGTH / 2);

// Crockford's base32 alphabet, which leaves out the letters that are easy to
// mistake for a digit (I, L, O) and U. Each character carries 5 bits, thus a
// code of 10 characters has 50 bits of entropy: far too many for online
// rate-limited guessing to succeed.
const ALPHABET = "0123456789abcdefghjkmnpqrstvwxyz";

/**
 * Generate a new set of backup codes, in the form the user sees them
 * (`xxxxx-xxxxx`).
 *
 * The codes of a set are distinct: the `backupCodes` table holds one row for
 * each code, and the lookup of a code expects at most one match.
 */
export function generateBackupCodes(): string[] {
  const codes = new Set<string>();
  while (codes.size < BACKUP_CODE_COUNT) {
    const bytes = crypto.getRandomValues(new Uint8Array(BACKUP_CODE_LENGTH));
    let code = "";
    for (const byte of bytes) {
      // The alphabet has 32 characters, thus the low 5 bits of a uniformly
      // random byte select a uniformly random character.
      code += ALPHABET[byte & 31];
    }
    codes.add(
      `${code.slice(0, BACKUP_CODE_SPLIT_POINT)}-${code.slice(BACKUP_CODE_SPLIT_POINT)}`,
    );
  }
  return [...codes];
}

/**
 * The hash of a backup code, as stored in the `backupCodes` table.
 *
 * The code is normalized before it is hashed, thus a code the user typed
 * hashes the same as the code they were shown. The normalization ignores the
 * case and every character that is not a letter or a digit (the hyphen,
 * spaces), and reads the letters that the alphabet leaves out as the digits
 * they resemble (`O` as `0`, `I` and `L` as `1`).
 */
export function hashBackupCode(code: string): Promise<string> {
  return sha256Hex(normalizeBackupCode(code));
}

function normalizeBackupCode(code: string): string {
  return code
    .toLowerCase()
    .replace(/[^0-9a-z]/g, "")
    .replace(/o/g, "0")
    .replace(/[il]/g, "1");
}
