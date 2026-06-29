import { SignJWT, importPKCS8 } from "jose";

const ALG = "RS256";

/** Signs a JWT that Convex will accept as a custom-JWT identity. */
export async function signJwt(opts: {
  privateKeyPkcs8: string;
  kid: string;
  subject: string;
  issuer: string;
  audience: string;
  expiresInSeconds: number;
}): Promise<{ token: string; expiresAt: number }> {
  const key = await importPKCS8(opts.privateKeyPkcs8, ALG);
  const nowSeconds = Math.floor(Date.now() / 1000);
  const expSeconds = nowSeconds + opts.expiresInSeconds;
  const token = await new SignJWT()
    .setProtectedHeader({ alg: ALG, kid: opts.kid, typ: "JWT" })
    .setSubject(opts.subject)
    .setIssuer(opts.issuer)
    .setAudience(opts.audience)
    .setIssuedAt(nowSeconds)
    .setExpirationTime(expSeconds)
    .sign(key);
  return { token, expiresAt: expSeconds * 1000 };
}

/** Cryptographically random opaque refresh token. */
export function generateRefreshToken(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  let binary = "";
  for (const b of bytes) binary += String.fromCharCode(b);
  return btoa(binary)
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}

/** SHA-256 hex hash, used so raw refresh tokens are never persisted. */
export async function hashToken(token: string): Promise<string> {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(token),
  );
  return Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}
