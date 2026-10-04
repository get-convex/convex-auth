import {
  createLocalJWKSet,
  exportJWK,
  exportPKCS8,
  generateKeyPair,
  importPKCS8,
  jwtVerify,
  SignJWT,
  type JSONWebKeySet,
} from "jose";
import { ConvexError } from "convex/values";

const ALG = "RS256";

export type AuthKeys = { authPrivateKey: string; authJwks: string };

/** Generate deployment-ready AUTH_PRIVATE_KEY (base64 PEM) and AUTH_JWKS. */
export async function generateAuthKeys(): Promise<AuthKeys> {
  const { publicKey, privateKey } = await generateKeyPair(ALG, {
    extractable: true,
  });
  return {
    authPrivateKey: btoa(await exportPKCS8(privateKey)),
    authJwks: JSON.stringify({
      keys: [
        {
          ...(await exportJWK(publicKey)),
          kid: crypto.randomUUID(),
          alg: ALG,
          use: "sig",
        },
      ],
    }),
  };
}

function configurationError(message: string): never {
  throw new ConvexError({ code: "AUTH_CONFIGURATION_ERROR", message });
}

/** Validate encoding, key material, and signing-key selection without exposing secrets. */
export async function validateAuthKeys({ authPrivateKey, authJwks }: AuthKeys) {
  let privateKeyPkcs8: string;
  try {
    if (
      !authPrivateKey ||
      !/^[A-Za-z0-9+/]+={0,2}$/.test(authPrivateKey) ||
      authPrivateKey.length % 4 !== 0
    )
      throw new Error();
    privateKeyPkcs8 = atob(authPrivateKey);
    if (
      !privateKeyPkcs8.startsWith("-----BEGIN PRIVATE KEY-----") ||
      !privateKeyPkcs8.trimEnd().endsWith("-----END PRIVATE KEY-----")
    )
      throw new Error();
  } catch {
    configurationError("AUTH_PRIVATE_KEY must contain base64-encoded PEM");
  }
  let privateKey: Awaited<ReturnType<typeof importPKCS8>>;
  try {
    privateKey = await importPKCS8(privateKeyPkcs8, ALG);
  } catch {
    configurationError(
      "AUTH_PRIVATE_KEY must encode a valid RS256 PKCS8 private key",
    );
  }
  let jwks: JSONWebKeySet;
  try {
    jwks = JSON.parse(authJwks);
    if (
      !Array.isArray(jwks.keys) ||
      jwks.keys.length === 0 ||
      jwks.keys.some((key) => "d" in key)
    )
      throw new Error();
    if (typeof jwks.keys[0].kid !== "string" || !jwks.keys[0].kid)
      throw new Error();
  } catch {
    configurationError(
      "AUTH_JWKS must contain a public JWKS with a signing key and kid",
    );
  }
  const kid = jwks.keys[0].kid!;
  // Fixed claims keep this preflight deterministic inside Convex queries.
  try {
    const token = await new SignJWT({ sub: "auth-configuration-check" })
      .setProtectedHeader({ alg: ALG, kid })
      .sign(privateKey);
    await jwtVerify(token, createLocalJWKSet(jwks), { algorithms: [ALG] });
  } catch {
    configurationError(
      "AUTH_PRIVATE_KEY must match the signing key in AUTH_JWKS",
    );
  }
  return { kid, privateKey };
}

/** Sign a test JWT and verify it against the JWKS actually served by the deployment. */
export async function checkAuthConfiguration(
  options: AuthKeys & { jwksUrl: string; issuer: string },
): Promise<void> {
  const { privateKey, kid } = await validateAuthKeys(options);
  try {
    const response = await fetch(options.jwksUrl);
    if (!response.ok) throw new Error();
    const jwks = (await response.json()) as JSONWebKeySet;
    const token = await new SignJWT()
      .setProtectedHeader({ alg: ALG, kid })
      .setSubject("auth-configuration-check")
      .setIssuer(options.issuer)
      .setAudience("convex")
      .setIssuedAt()
      .setExpirationTime("1m")
      .sign(privateKey);
    await jwtVerify(token, createLocalJWKSet(jwks), {
      algorithms: [ALG],
      issuer: options.issuer,
      audience: "convex",
    });
  } catch {
    configurationError(
      "Auth configuration check failed: the served JWKS must verify a JWT signed by AUTH_PRIVATE_KEY",
    );
  }
}
