// Crypto helpers for the OAuth provider. Used by the app-side recipe to mint
// flow secrets (the state, the PKCE verifier and its challenge).

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
