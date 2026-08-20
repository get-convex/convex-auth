// Ported from @oslojs/crypto (https://github.com/oslo-project/crypto),
// MIT license. See README.md in this directory. The original test decoded
// a PKIX (SPKI) public key; the PKIX decoder is trimmed from the vendored
// code, so the key is built from its JWK components instead.
import { expect, test } from "vitest";
import {
  decodePKCS1RSAPublicKey,
  RSAPublicKey,
  sha256ObjectIdentifier,
  verifyRSASSAPKCS1v15Signature,
} from "./rsa.ts";
import { bigIntFromBytes } from "../binary/index.ts";
import { decodeBase64urlIgnorePadding } from "../encoding/index.ts";
import { sha256 } from "./sha2.ts";

const data = new TextEncoder().encode("hello world");

async function generateKeyAndSignature(): Promise<{
  publicKey: RSAPublicKey;
  signature: Uint8Array;
}> {
  const webcryptoKeys = await crypto.subtle.generateKey(
    {
      name: "RSASSA-PKCS1-v1_5",
      modulusLength: 2048,
      publicExponent: new Uint8Array([0x01, 0x00, 0x01]),
      hash: "SHA-256",
    },
    true,
    ["verify", "sign"],
  );
  const jwk = await crypto.subtle.exportKey("jwk", webcryptoKeys.publicKey);
  const publicKey = new RSAPublicKey(
    bigIntFromBytes(decodeBase64urlIgnorePadding(jwk.n!)),
    bigIntFromBytes(decodeBase64urlIgnorePadding(jwk.e!)),
  );
  const signature = new Uint8Array(
    await crypto.subtle.sign(
      { name: "RSASSA-PKCS1-v1_5" },
      webcryptoKeys.privateKey,
      data,
    ),
  );
  return { publicKey, signature };
}

test("verifyRSASSAPKCS1v15Signature()", async () => {
  const { publicKey, signature } = await generateKeyAndSignature();
  expect(
    verifyRSASSAPKCS1v15Signature(
      publicKey,
      sha256ObjectIdentifier,
      sha256(data),
      signature,
    ),
  ).toBe(true);
  expect(
    verifyRSASSAPKCS1v15Signature(
      publicKey,
      sha256ObjectIdentifier,
      sha256(new TextEncoder().encode("HELLO WORLD")),
      signature,
    ),
  ).toBe(false);
  const tampered = signature.slice();
  tampered[0] ^= 0x01;
  expect(
    verifyRSASSAPKCS1v15Signature(
      publicKey,
      sha256ObjectIdentifier,
      sha256(data),
      tampered,
    ),
  ).toBe(false);
});

test("RSAPublicKey.encodePKCS1() and decodePKCS1RSAPublicKey()", async () => {
  const { publicKey, signature } = await generateKeyAndSignature();
  const decoded = decodePKCS1RSAPublicKey(publicKey.encodePKCS1());
  expect(decoded.n).toBe(publicKey.n);
  expect(decoded.e).toBe(publicKey.e);
  expect(
    verifyRSASSAPKCS1v15Signature(
      decoded,
      sha256ObjectIdentifier,
      sha256(data),
      signature,
    ),
  ).toBe(true);
});
