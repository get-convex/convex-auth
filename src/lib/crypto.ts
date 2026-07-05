/**
 * Small token-crypto helpers shared by the auth components. Both the core
 * (refresh tokens) and providers (OAuth one-time codes) mint opaque random
 * tokens and persist only their hashes, so the primitives live here rather
 * than in any one component.
 */

/** Cryptographically random opaque token (32 bytes, base64url). */
export function generateToken(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  let binary = "";
  for (const b of bytes) binary += String.fromCharCode(b);
  return btoa(binary)
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}

/** SHA-256 hex hash, used so raw tokens are never persisted. */
export async function hashToken(token: string): Promise<string> {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(token),
  );
  return Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}
