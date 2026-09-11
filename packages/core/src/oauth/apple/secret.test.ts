import {
  decodeJwt,
  decodeProtectedHeader,
  exportPKCS8,
  generateKeyPair,
  jwtVerify,
} from "jose";
import { beforeAll, describe, expect, test } from "vitest";
import {
  importApplePrivateKey,
  mintClientSecret,
  toPkcs8Pem,
} from "./secret.ts";

/**
 * A real P-256 key pair, generated once for the suite. Apple's `.p8` file
 * holds the private half in exactly the PKCS#8 PEM shape `exportPKCS8`
 * produces, so this stands in for one.
 */
let privateKeyPem: string;
let publicKey: CryptoKey;

beforeAll(async () => {
  const pair = await generateKeyPair("ES256", { extractable: true });
  privateKeyPem = await exportPKCS8(pair.privateKey);
  publicKey = pair.publicKey as CryptoKey;
});

/** The key's base64 body, with the header and footer lines taken off. */
function base64Body(): string {
  return privateKeyPem
    .replace(/-----(BEGIN|END) PRIVATE KEY-----/g, "")
    .replace(/\s+/g, "");
}

describe("toPkcs8Pem", () => {
  test("the .p8 file's contents are passed through", () => {
    expect(toPkcs8Pem(privateKeyPem)).toBe(privateKeyPem.trim());
  });

  test("surrounding whitespace is trimmed off", () => {
    expect(toPkcs8Pem(`\n  ${privateKeyPem}\n\n`)).toBe(privateKeyPem.trim());
  });

  test("newlines written as literal backslash-n are restored", () => {
    const escaped = privateKeyPem.trim().replace(/\n/g, "\\n");
    expect(toPkcs8Pem(escaped)).toBe(privateKeyPem.trim());
  });

  test("the base64 body alone gets the header and footer back", () => {
    const pem = toPkcs8Pem(base64Body());
    expect(pem.startsWith("-----BEGIN PRIVATE KEY-----\n")).toBe(true);
    expect(pem.endsWith("\n-----END PRIVATE KEY-----")).toBe(true);
    expect(pem.replace(/-----(BEGIN|END) PRIVATE KEY-----/g, "").trim()).toBe(
      base64Body(),
    );
  });
});

describe("importApplePrivateKey", () => {
  test("the .p8 file's contents load", async () => {
    await expect(importApplePrivateKey(privateKeyPem)).resolves.toBeDefined();
  });

  test.each([
    ["an empty value", ""],
    ["only whitespace", "   \n  "],
    ["prose", "this is not a key"],
    [
      "an RSA-style header",
      "-----BEGIN RSA PRIVATE KEY-----\nabc\n-----END RSA PRIVATE KEY-----",
    ],
    ["base64 that decodes to nothing useful", "aGVsbG8gd29ybGQ="],
  ])("%s is rejected with the file to set it from", async (_name, value) => {
    await expect(importApplePrivateKey(value)).rejects.toThrow(
      /not a P-256 private key.*AuthKey_<KEY_ID>\.p8/s,
    );
  });
});

describe("mintClientSecret", () => {
  /** What Apple's docs specify, and what the token endpoint checks. */
  const OPTIONS = {
    teamId: "DEF123GHIJ",
    keyId: "ABC123DEFG",
    clientId: "com.example.app.web",
  };

  test("the secret carries Apple's header and claims and verifies against the key", async () => {
    const before = Math.floor(Date.now() / 1000);
    const secret = await mintClientSecret({
      privateKey: privateKeyPem,
      ...OPTIONS,
    });

    expect(decodeProtectedHeader(secret)).toEqual({
      alg: "ES256",
      kid: OPTIONS.keyId,
      typ: "JWT",
    });

    const { payload } = await jwtVerify(secret, publicKey, {
      issuer: OPTIONS.teamId,
      audience: "https://appleid.apple.com",
      subject: OPTIONS.clientId,
    });
    expect(payload.iat).toBeGreaterThanOrEqual(before);
    expect(payload.exp).toBe(payload.iat! + 300);
  });

  test("a key whose newlines were escaped signs the same way", async () => {
    const escaped = privateKeyPem.trim().replace(/\n/g, "\\n");
    const secret = await mintClientSecret({ privateKey: escaped, ...OPTIONS });
    await expect(jwtVerify(secret, publicKey)).resolves.toBeDefined();
    expect(decodeJwt(secret).iss).toBe(OPTIONS.teamId);
  });

  test("a key that isn't a key is rejected before signing", async () => {
    await expect(
      mintClientSecret({ privateKey: "nope", ...OPTIONS }),
    ).rejects.toThrow(/not a P-256 private key/);
  });

  test("no secret is produced from a key of the wrong type", async () => {
    const rsa = await generateKeyPair("RS256", { extractable: true });
    await expect(
      mintClientSecret({
        privateKey: await exportPKCS8(rsa.privateKey),
        ...OPTIONS,
      }),
    ).rejects.toThrow();
  });
});
