import { SignJWT, importPKCS8, type KeyLike } from "jose";

const ALG = "RS256";

/** Signs a JWT that Convex will accept as a custom-JWT identity. */
export async function signJwt(
  opts: {
    kid: string;
    subject: string;
    issuer: string;
    audience: string;
    expiresInSeconds: number;
  } & ({ privateKey: KeyLike } | { privateKeyPkcs8: string }),
): Promise<{ token: string; expiresAt: number }> {
  const key =
    "privateKey" in opts
      ? opts.privateKey
      : await importPKCS8(opts.privateKeyPkcs8, ALG);
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
