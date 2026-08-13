/**
 * Crypto helpers shared across the core and provider components.
 */

/**
 * SHA-256 hex digest. Used wherever a secret (refresh token, OAuth state,
 * ticket code) must be looked up later without persisting the raw value.
 */
export async function sha256Hex(value: string): Promise<string> {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(value),
  );
  return Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}
