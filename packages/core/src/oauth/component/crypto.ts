// Crypto helpers for the OAuth provider. Used by both the app-side recipe
// (PKCE, ticket decryption) and the component itself (ticket encryption,
// decoding id_tokens).

function base64UrlEncode(bytes: Uint8Array): string {
  const binary = Array.from(bytes, (b) => String.fromCharCode(b)).join("");
  return btoa(binary)
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
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
export function decodeJwtPayloadUnverified(
  jwt: string,
): Record<string, unknown> {
  const parts = jwt.split(".");
  if (parts.length !== 3) {
    throw new Error("Malformed JWT");
  }
  return JSON.parse(new TextDecoder().decode(base64UrlDecode(parts[1])));
}

/**
 * AES-256-GCM key for a ticket payload. The key is only as strong as the
 * ticket code, which is 256 bits of randomness. The prefix is load-bearing:
 * the ticket row stores SHA-256(code) as its lookup hash, so without it the
 * stored hash would be the key.
 */
async function deriveTicketPayloadKey(ticketCode: string): Promise<CryptoKey> {
  const keyBytes = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(`convex-auth-ticket-payload:${ticketCode}`),
  );
  return await crypto.subtle.importKey("raw", keyBytes, "AES-GCM", false, [
    "encrypt",
    "decrypt",
  ]);
}

/**
 * Encrypt a ticket payload with a key derived from the raw ticket code.
 *
 * A ticket is the short-lived, one-time record the callback mints after a
 * successful code exchange (the `tickets` table in schema.ts); its payload
 * is the provider-attested identity JSON (`{ claims, userInfoResponses }`)
 * that redemption decrypts. Only the code's hash is persisted, and the raw
 * code (the only value the key can be derived from) travels solely in the
 * callback redirect URL, so database access alone cannot decrypt the
 * result. Returns the random nonce followed by the ciphertext,
 * base64url-encoded.
 */
export async function encryptTicketPayload(
  ticketCode: string,
  plaintext: string,
): Promise<string> {
  const key = await deriveTicketPayloadKey(ticketCode);
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
 * Decrypt {@link encryptTicketPayload} output. Throws when the ticket code
 * is wrong or the payload was tampered with (AES-GCM authenticates).
 */
export async function decryptTicketPayload(
  ticketCode: string,
  encrypted: string,
): Promise<string> {
  const key = await deriveTicketPayloadKey(ticketCode);
  const combined = base64UrlDecode(encrypted);
  const plaintext = await crypto.subtle.decrypt(
    { name: "AES-GCM", iv: combined.slice(0, 12) },
    key,
    combined.slice(12),
  );
  return new TextDecoder().decode(plaintext);
}
