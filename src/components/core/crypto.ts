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

// The token minting/hashing primitives are shared with provider components
// (e.g. the oauth component's one-time sign-in codes), so they live in the
// shared lib; the core re-exports them under its own names.
export {
  generateToken as generateRefreshToken,
  hashToken,
} from "../../lib/crypto.js";
