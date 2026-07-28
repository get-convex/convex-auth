import { sha256 } from "@oslojs/crypto/sha2";
import { constantTimeEqual } from "@oslojs/crypto/subtle";
import { encodeBase64urlNoPadding } from "@oslojs/encoding";

/**
 * Storage-agnostic session helpers, following the token model described at
 * https://auth.pilcrowonpaper.com/sessions.
 *
 * A session is identified to the client by a `<id>.<secret>` string. The store
 * keeps only the SHA-256 hash of the secret; verification hashes the presented
 * secret and compares in constant time. Because the secret has 256 bits of
 * entropy a plain SHA-256 (no salt, no slow KDF) is sufficient — an attacker
 * cannot feasibly brute-force the pre-image, and there is no low-entropy input
 * that would make a rainbow table worthwhile.
 *
 * These helpers hold no Convex or storage dependency so they can be unit-tested
 * in isolation and reused by any component that needs opaque bearer secrets.
 */

// Re-export oslo's constant-time comparison rather than reimplementing it, so
// callers get a single audited implementation.
export { constantTimeEqual };

// 32 unambiguous characters (Crockford-style: no I, O, 0, 1). Exactly 32 so a
// single byte masked with `& 31` selects one uniformly (256 is a multiple of
// 32, so there is no modulo bias).
const SHORT_CODE_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";

/**
 * Generate the high-entropy secret half of a session string: 32 random bytes
 * (256 bits) encoded as unpadded base64url so it is URL/JSON safe.
 */
export function generateSessionSecret(): string {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  return encodeBase64urlNoPadding(bytes);
}

/**
 * Generate a short, human-typeable code drawn uniformly from an unambiguous
 * 32-character alphabet. Used as the second factor delivered out-of-band (e.g.
 * by email); the entropy is ~5 bits per character (8 chars ≈ 40 bits), which is
 * only safe in combination with a strict rate limit on verification attempts.
 */
export function generateShortCode(length: number = 8): string {
  const bytes = new Uint8Array(length);
  crypto.getRandomValues(bytes);
  let code = "";
  for (let i = 0; i < length; i++) {
    code += SHORT_CODE_ALPHABET[bytes[i] & 31];
  }
  return code;
}

/**
 * Normalize a user-entered short code for comparison: trim surrounding
 * whitespace and uppercase (the alphabet is uppercase-only). Callers should
 * normalize both the generated and the presented code the same way.
 */
export function normalizeShortCode(code: string): string {
  return code.trim().toUpperCase();
}

/**
 * Hash a secret (or code) for storage. Returns a 32-byte SHA-256 digest as an
 * `ArrayBuffer`, ready to persist through a `v.bytes()` field.
 */
export function hashSecret(value: string): ArrayBuffer {
  const digest = sha256(new TextEncoder().encode(value));
  // `sha256` returns a fresh 32-byte Uint8Array, but slice defensively so the
  // returned buffer is exactly the digest with no surrounding bytes.
  return digest.buffer.slice(
    digest.byteOffset,
    digest.byteOffset + digest.byteLength,
  ) as ArrayBuffer;
}

/** Coerce a stored `v.bytes()` value back to a `Uint8Array` for comparison. */
export function bytesToUint8Array(bytes: ArrayBuffer): Uint8Array {
  return new Uint8Array(bytes);
}

/**
 * Build the client-facing session string from an id and its secret. The id is
 * stored/looked-up in the clear; the secret is the bearer credential. Split on
 * the *first* `.` so an id that happens to contain a `.` round-trips.
 */
export function buildSessionString(id: string, secret: string): string {
  return `${id}.${secret}`;
}

/**
 * Parse a `<id>.<secret>` session string. Returns `null` when the string is
 * malformed (no separator, or an empty id/secret).
 */
export function parseSessionString(
  session: string,
): { id: string; secret: string } | null {
  const separator = session.indexOf(".");
  if (separator === -1) {
    return null;
  }
  const id = session.slice(0, separator);
  const secret = session.slice(separator + 1);
  if (id === "" || secret === "") {
    return null;
  }
  return { id, secret };
}
