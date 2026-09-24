/**
 * HOTP (RFC 4226) and TOTP (RFC 6238), on top of Web Crypto.
 *
 * These functions have no Convex dependency. The component's public functions
 * call them, and tests check them against the test vectors of the two RFCs.
 */

// The Web Crypto names of the hash functions, which `crypto.subtle` takes as
// they are.
export type TotpAlgorithm = "SHA-1" | "SHA-256" | "SHA-512";

export type TotpParams = {
  /** The shared secret, base32-encoded. */
  secret: string;
  algorithm: TotpAlgorithm;
  digits: number;
  /** The time step, in seconds. */
  period: number;
};

// The defaults that all authenticator apps support. Some apps ignore the
// `algorithm`, `digits` and `period` parameters of the otpauth URI and use
// these values regardless, thus a different choice is a compatibility risk.
export const DEFAULT_ALGORITHM: TotpAlgorithm = "SHA-1";
export const DEFAULT_DIGITS = 6;
export const DEFAULT_PERIOD = 30;

// RFC 4226 recommends a secret of at least 128 bits and suggests 160 bits,
// the output size of SHA-1.
const SECRET_BYTES = 20;

// RFC 4648 base32 alphabet. Authenticator apps decode the secret in an
// otpauth URI with this alphabet.
const BASE32_ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";

/**
 * Encode bytes as base32 (RFC 4648), without padding.
 */
export function base32Encode(bytes: Uint8Array): string {
  let bits = 0;
  let value = 0;
  let output = "";
  for (const byte of bytes) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      output += BASE32_ALPHABET[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) {
    output += BASE32_ALPHABET[(value << (5 - bits)) & 31];
  }
  return output;
}

/**
 * Decode base32 (RFC 4648). The decoder ignores the case, padding and
 * whitespace. It throws on any other character, and on text that no byte
 * sequence encodes to: a length that padding-stripped base32 cannot have, or
 * unused bits in the final character that are not zero.
 */
export function base32Decode(text: string): Uint8Array<ArrayBuffer> {
  const cleaned = text.toUpperCase().replace(/[\s=]/g, "");
  // A group of 8 characters encodes 5 bytes. A trailing partial group has 2,
  // 4, 5 or 7 characters (for 1 to 4 bytes); the other lengths encode nothing.
  if ([1, 3, 6].includes(cleaned.length % 8)) {
    throw new Error(`Invalid base32 length: ${cleaned.length}`);
  }
  const output: number[] = [];
  let bits = 0;
  let value = 0;
  for (const character of cleaned) {
    const index = BASE32_ALPHABET.indexOf(character);
    if (index === -1) {
      throw new Error(`Invalid base32 character: ${JSON.stringify(character)}`);
    }
    value = (value << 5) | index;
    bits += 5;
    if (bits >= 8) {
      output.push((value >>> (bits - 8)) & 0xff);
      bits -= 8;
    }
  }
  // The leftover bits pad the final character; the encoder sets them to zero.
  if ((value & ((1 << bits) - 1)) !== 0) {
    throw new Error("Invalid base32: the unused trailing bits are not zero");
  }
  return new Uint8Array(output);
}

/**
 * Generate a new random secret.
 */
export function generateSecret(): Uint8Array<ArrayBuffer> {
  return crypto.getRandomValues(new Uint8Array(SECRET_BYTES));
}

/**
 * Compute an HOTP code (RFC 4226) for a counter value.
 */
export async function hotp(
  secret: Uint8Array<ArrayBuffer>,
  counter: number,
  options: { algorithm: TotpAlgorithm; digits: number },
): Promise<string> {
  // The counter is an 8-byte big-endian integer. A JavaScript number holds
  // it exactly up to 2^53, far beyond any time-step counter.
  const message = new Uint8Array(8);
  const view = new DataView(message.buffer);
  view.setUint32(0, Math.floor(counter / 2 ** 32));
  view.setUint32(4, counter >>> 0);

  const key = await crypto.subtle.importKey(
    "raw",
    secret,
    { name: "HMAC", hash: options.algorithm },
    false,
    ["sign"],
  );
  const hmac = new Uint8Array(await crypto.subtle.sign("HMAC", key, message));

  // Dynamic truncation (RFC 4226, section 5.3): the low 4 bits of the last
  // byte select 4 bytes of the digest, read as a 31-bit big-endian integer.
  const offset = hmac[hmac.length - 1] & 0x0f;
  const binary =
    ((hmac[offset] & 0x7f) << 24) |
    (hmac[offset + 1] << 16) |
    (hmac[offset + 2] << 8) |
    hmac[offset + 3];
  return String(binary % 10 ** options.digits).padStart(options.digits, "0");
}

/**
 * The time-step counter (RFC 6238) of a moment in time.
 */
export function totpCounter(timestampMs: number, period: number): number {
  return Math.floor(timestampMs / 1000 / period);
}

/**
 * Compute the TOTP code (RFC 6238) that is valid at a moment in time.
 */
export async function totp(
  params: TotpParams,
  timestampMs: number,
): Promise<string> {
  return hotp(
    base32Decode(params.secret),
    totpCounter(timestampMs, params.period),
    params,
  );
}

/**
 * Throw if `issuer` can't appear in an otpauth URI label.
 *
 * The Key Uri Format forbids a colon in the issuer: authenticator apps split
 * the label at its first colon, literal or percent-encoded, so a colon in the
 * issuer moves part of it into the account name.
 */
export function assertValidIssuer(issuer: string) {
  if (issuer.includes(":")) {
    throw new Error(
      `Invalid TOTP issuer ${JSON.stringify(issuer)}: it must not contain a colon`,
    );
  }
}

/**
 * Build the `otpauth://` URI (the "Key Uri Format") that authenticator apps
 * read from a QR code.
 *
 * `issuer` names the application and `accountName` names the account, for
 * example the user's email address. An authenticator app shows both. It
 * throws if `issuer` contains a colon.
 */
export function otpauthUri(
  params: TotpParams & { issuer: string; accountName: string },
): string {
  assertValidIssuer(params.issuer);
  const label = `${encodeURIComponent(params.issuer)}:${encodeURIComponent(
    params.accountName,
  )}`;
  // Percent-encoding throughout. `URLSearchParams` would write a space as
  // `+`, which some authenticator apps show as a literal plus sign.
  const query = (
    [
      ["secret", params.secret],
      ["issuer", params.issuer],
      // The Key Uri Format spells the algorithm without the hyphen: `SHA1`.
      ["algorithm", params.algorithm.replace("-", "")],
      ["digits", String(params.digits)],
      ["period", String(params.period)],
    ] satisfies [string, string][]
  )
    .map(([key, value]) => `${key}=${encodeURIComponent(value)}`)
    .join("&");
  return `otpauth://totp/${label}?${query}`;
}

/**
 * Compare two strings in time that depends on their length only, not on
 * their content.
 */
export function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) {
    return false;
  }
  let difference = 0;
  for (let i = 0; i < a.length; i++) {
    difference |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }
  return difference === 0;
}
