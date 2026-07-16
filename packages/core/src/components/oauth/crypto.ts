/**
 * Crypto helpers for the OAuth provider. Used by both the app-side recipe
 * (hashing state before it crosses the component boundary) and the component
 * itself (hashing one-time tokens at rest).
 */

function base64UrlEncode(bytes: Uint8Array): string {
  const binary = Array.from(bytes, (b) => String.fromCharCode(b)).join("");
  return btoa(binary)
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}

/** SHA-256 hex digest, used so raw state and one-time tokens are never persisted. */
export async function sha256Hex(value: string): Promise<string> {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(value),
  );
  return Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

/** base64url(SHA-256(value)) — the PKCE `S256` code challenge encoding. */
export async function sha256Base64Url(value: string): Promise<string> {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(value),
  );
  return base64UrlEncode(new Uint8Array(digest));
}

/** Cryptographically random 256-bit opaque token, base64url encoded. */
export function generateRandomToken(): string {
  return base64UrlEncode(crypto.getRandomValues(new Uint8Array(32)));
}

function base64UrlDecode(value: string): Uint8Array {
  const base64 = value
    .replace(/-/g, "+")
    .replace(/_/g, "/")
    .padEnd(Math.ceil(value.length / 4) * 4, "=");
  const binary = atob(base64);
  return Uint8Array.from(binary, (c) => c.charCodeAt(0));
}

/**
 * Decode a JWT's payload without verifying its signature. Only safe for
 * tokens received directly from the issuer over TLS (e.g. an id_token from
 * the token exchange), where transport authenticates the issuer.
 */
export function decodeJwtPayload(jwt: string): Record<string, unknown> {
  const parts = jwt.split(".");
  if (parts.length !== 3) {
    throw new Error("Malformed JWT");
  }
  return JSON.parse(new TextDecoder().decode(base64UrlDecode(parts[1])));
}

/**
 * Derive an AES-256-GCM key from a raw one-time token. A domain-separated
 * SHA-256 suffices as the KDF: the token is itself 256 bits of CSPRNG
 * output, so no stretching is needed.
 */
async function deriveTokenKey(token: string): Promise<CryptoKey> {
  const keyBytes = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(`convex-auth-ticket-payload:${token}`),
  );
  return await crypto.subtle.importKey("raw", keyBytes, "AES-GCM", false, [
    "encrypt",
    "decrypt",
  ]);
}

/**
 * Encrypt a ticket payload with a key derived from the raw one-time token.
 * The token is never persisted (only its hash is), so database access alone
 * cannot decrypt the result; the key preimage travels only in the callback
 * redirect URL. Returns base64url(iv || ciphertext).
 */
export async function encryptWithToken(
  token: string,
  plaintext: string,
): Promise<string> {
  const key = await deriveTokenKey(token);
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ciphertext = new Uint8Array(
    await crypto.subtle.encrypt(
      { name: "AES-GCM", iv },
      key,
      new TextEncoder().encode(plaintext),
    ),
  );
  const combined = new Uint8Array(iv.length + ciphertext.length);
  combined.set(iv);
  combined.set(ciphertext, iv.length);
  return base64UrlEncode(combined);
}

/**
 * Decrypt {@link encryptWithToken} output. Throws when the token is wrong
 * or the payload was tampered with (AES-GCM authenticates).
 */
export async function decryptWithToken(
  token: string,
  encrypted: string,
): Promise<string> {
  const key = await deriveTokenKey(token);
  const combined = base64UrlDecode(encrypted);
  const plaintext = await crypto.subtle.decrypt(
    { name: "AES-GCM", iv: combined.slice(0, 12) },
    key,
    combined.slice(12),
  );
  return new TextDecoder().decode(plaintext);
}
