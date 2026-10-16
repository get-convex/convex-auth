import { SignJWT, importPKCS8 } from "jose";

const ALG = "RS256";

type SigningKey = Awaited<ReturnType<typeof importPKCS8>>;

const REGENERATE_HINT =
  "Run `npx @convex-dev/auth --force` to generate a new key pair and set " +
  "AUTH_PRIVATE_KEY and AUTH_JWKS.";

function invalidEnvVar(name: string, expected: string, cause: unknown): Error {
  const reason = cause === undefined ? "" : ` (${String(cause)})`;
  return new Error(`${name} is not ${expected}${reason}. ${REGENERATE_HINT}`, {
    cause,
  });
}

/**
 * Read the signing key and its key id from the values of the
 * `AUTH_PRIVATE_KEY` and `AUTH_JWKS` env vars. A malformed value throws an
 * error that names the env var, instead of the error of the parser.
 */
export async function importSigningKey(env: {
  AUTH_PRIVATE_KEY: string;
  AUTH_JWKS: string;
}): Promise<{ key: SigningKey; kid: string }> {
  let jwks: unknown;
  try {
    jwks = JSON.parse(env.AUTH_JWKS);
  } catch (cause) {
    throw invalidEnvVar("AUTH_JWKS", "valid JSON", cause);
  }
  const kid = (jwks as { keys?: { kid?: unknown }[] } | null)?.keys?.[0]?.kid;
  if (typeof kid !== "string") {
    throw invalidEnvVar(
      "AUTH_JWKS",
      'a JWKS whose first key has a "kid"',
      undefined,
    );
  }

  let pkcs8: string;
  try {
    pkcs8 = atob(env.AUTH_PRIVATE_KEY);
  } catch (cause) {
    throw invalidEnvVar(
      "AUTH_PRIVATE_KEY",
      "a base64-encoded PKCS#8 private key",
      cause,
    );
  }
  let key: SigningKey;
  try {
    key = await importPKCS8(pkcs8, ALG);
  } catch (cause) {
    throw invalidEnvVar(
      "AUTH_PRIVATE_KEY",
      "a base64-encoded PKCS#8 RSA private key",
      cause,
    );
  }
  return { key, kid };
}

/** Signs a JWT that Convex will accept as a custom-JWT identity. */
export async function signJwt(opts: {
  key: SigningKey;
  kid: string;
  subject: string;
  issuer: string;
  audience: string;
  expiresInSeconds: number;
}): Promise<{ token: string; expiresAt: number }> {
  const nowSeconds = Math.floor(Date.now() / 1000);
  const expSeconds = nowSeconds + opts.expiresInSeconds;
  const token = await new SignJWT()
    .setProtectedHeader({ alg: ALG, kid: opts.kid, typ: "JWT" })
    .setSubject(opts.subject)
    .setIssuer(opts.issuer)
    .setAudience(opts.audience)
    .setIssuedAt(nowSeconds)
    .setExpirationTime(expSeconds)
    .sign(opts.key);
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
