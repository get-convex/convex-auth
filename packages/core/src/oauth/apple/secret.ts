/**
 * Apple's client secret.
 *
 * Apple issues no static client secret. Instead, every token exchange has to
 * present a short-lived JWT signed with the Sign in with Apple key from your
 * developer account.
 *
 * @module
 */
import { SignJWT, importPKCS8, type KeyLike } from "jose";

/** The only algorithm Apple accepts for the client secret. */
const ALG = "ES256";

/** Who the client secret is addressed to, per Apple's docs. */
const AUDIENCE = "https://appleid.apple.com";

/**
 * How long a minted secret stays valid. Apple's ceiling is six months, but
 * the secret is signed per exchange and used immediately, so it only needs to
 * outlive one request.
 */
const TTL_SECONDS = 5 * 60;

const PEM_HEADER = "-----BEGIN PRIVATE KEY-----";
const PEM_FOOTER = "-----END PRIVATE KEY-----";

/**
 * Put an Apple `.p8` key into the PKCS#8 PEM shape `importPKCS8` requires:
 * the header line, then the base64, then the footer line. The file Apple
 * gives you is already in that shape, but copying it into an environment
 * variable often changes it, so `privateKey` may be given in any of these
 * forms:
 *
 * - the file's contents, unchanged
 * - the same thing with its newlines written as literal `\n`
 * - the base64 body alone, with the header and footer lines stripped off
 *
 * This only reshapes the text. Whether the result is really a key is checked
 * by {@link importApplePrivateKey}.
 */
export function toPkcs8Pem(privateKey: string): string {
  const unescaped = privateKey.trim().replace(/\\n/g, "\n");
  if (unescaped.startsWith(PEM_HEADER)) {
    return unescaped;
  }
  return `${PEM_HEADER}\n${unescaped.replace(/\s+/g, "")}\n${PEM_FOOTER}`;
}

/**
 * Load the signing key, turning every way of getting it wrong into one
 * message that names the file it should have come from.
 */
export async function importApplePrivateKey(
  privateKey: string,
): Promise<KeyLike> {
  try {
    return await importPKCS8(toPkcs8Pem(privateKey), ALG);
  } catch (cause) {
    throw new Error(
      "The Apple component's PRIVATE_KEY is not a P-256 private key. Set it " +
        "to the contents of the AuthKey_<KEY_ID>.p8 file from your Apple " +
        "developer account, e.g. `npx convex env set AUTH_APPLE_PRIVATE_KEY " +
        `< AuthKey_ABC123DEFG.p8\`. Reading it failed with: ${String(cause)}`,
      { cause },
    );
  }
}

/**
 * Sign the client secret for one token exchange. The claims are Apple's:
 * the team owns the key, the Services ID is what the secret speaks for, and
 * Apple's own server is the only intended recipient.
 */
export async function mintClientSecret(options: {
  /** The `.p8` key's contents, as `PRIVATE_KEY` holds them. */
  privateKey: string;
  /** The 10-character team id, which becomes `iss`. */
  teamId: string;
  /** The 10-character key id, which becomes the JWT header's `kid`. */
  keyId: string;
  /** The Services ID. It is the `client_id`, and this JWT's `sub`. */
  clientId: string;
}): Promise<string> {
  const key = await importApplePrivateKey(options.privateKey);
  const issuedAt = Math.floor(Date.now() / 1000);
  return await new SignJWT()
    .setProtectedHeader({ alg: ALG, kid: options.keyId, typ: "JWT" })
    .setIssuer(options.teamId)
    .setSubject(options.clientId)
    .setAudience(AUDIENCE)
    .setIssuedAt(issuedAt)
    .setExpirationTime(issuedAt + TTL_SECONDS)
    .sign(key);
}
