/** Byte plumbing that the ceremony builders need. */

/** View a byte array as the `ArrayBuffer` that a Convex argument holds. */
export function toArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  return bytes.byteOffset === 0 && bytes.byteLength === bytes.buffer.byteLength
    ? (bytes.buffer as ArrayBuffer)
    : (bytes.buffer.slice(
        bytes.byteOffset,
        bytes.byteOffset + bytes.byteLength,
      ) as ArrayBuffer);
}

/** Encode bytes as base64url without padding, the way WebAuthn does. */
export function encodeBase64url(bytes: Uint8Array): string {
  return btoa(String.fromCharCode(...bytes))
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replace(/=+$/, "");
}

/**
 * Decode a base64url string. A JWK member carries no padding, and `atob`
 * refuses a partial padding, thus complete the last group first.
 */
export function decodeBase64url(text: string): Uint8Array {
  const base64 = text.replaceAll("-", "+").replaceAll("_", "/");
  const padded = base64.padEnd(Math.ceil(base64.length / 4) * 4, "=");
  return Uint8Array.from(atob(padded), (character) => character.charCodeAt(0));
}

export async function sha256(bytes: Uint8Array): Promise<Uint8Array> {
  return new Uint8Array(
    await crypto.subtle.digest("SHA-256", toArrayBuffer(bytes)),
  );
}

/** DER-encode one unsigned integer as an ASN.1 INTEGER. */
function derInteger(bytes: Uint8Array): number[] {
  let start = 0;
  while (start < bytes.length - 1 && bytes[start] === 0) start++;
  const body = [...bytes.slice(start)];
  // An ASN.1 INTEGER is signed, thus a leading zero keeps it positive.
  if ((body[0] & 0x80) !== 0) body.unshift(0);
  return [0x02, body.length, ...body];
}

/**
 * Convert an ECDSA signature from the IEEE P1363 encoding (`r || s`, what
 * WebCrypto emits) to the DER encoding (what WebAuthn transports).
 */
export function toDERSignature(p1363: Uint8Array): Uint8Array {
  const half = p1363.length / 2;
  const body = [
    ...derInteger(p1363.slice(0, half)),
    ...derInteger(p1363.slice(half)),
  ];
  // `r` and `s` are 32 bytes each, thus the body is always shorter than 128
  // bytes and the length is a single byte.
  return new Uint8Array([0x30, body.length, ...body]);
}
