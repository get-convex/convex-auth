// Ported from @oslojs/crypto (https://github.com/oslo-project/crypto),
// MIT license. See README.md in this directory. The original tests used
// `node:crypto` to generate reference signatures; these use the WebCrypto
// API instead (WebCrypto ECDSA signatures use the IEEE P1363 encoding).
import { describe, expect, test } from "vitest";
import {
  decodeIEEEP1363ECDSASignature,
  decodePKIXECDSASignature,
  decodeSEC1PublicKey,
  ECDSANamedCurve,
  ECDSAPoint,
  ECDSAPublicKey,
  p256,
  verifyECDSASignature,
} from "./ecdsa";
import { sha256 } from "./sha2";

async function generateP256KeyAndSignature(): Promise<{
  publicKeySEC1: Uint8Array;
  signatureP1363: Uint8Array;
  data: Uint8Array;
}> {
  const data = new TextEncoder().encode("hello world");
  const webcryptoKeys = await crypto.subtle.generateKey(
    { name: "ECDSA", namedCurve: "P-256" },
    true,
    ["sign", "verify"],
  );
  const signature = await crypto.subtle.sign(
    { name: "ECDSA", hash: "SHA-256" },
    webcryptoKeys.privateKey,
    data,
  );
  const raw = await crypto.subtle.exportKey("raw", webcryptoKeys.publicKey);
  return {
    publicKeySEC1: new Uint8Array(raw),
    signatureP1363: new Uint8Array(signature),
    data,
  };
}

test("ECDSASignature.encodeIEEEP1363() and decodeIEEEP1363ECDSASignature()", async () => {
  const { signatureP1363 } = await generateP256KeyAndSignature();
  const signature = decodeIEEEP1363ECDSASignature(p256, signatureP1363);
  expect(signature.encodeIEEEP1363(p256)).toStrictEqual(signatureP1363);
});

test("ECDSASignature.encodePKIX() and decodePKIXECDSASignature()", async () => {
  const { signatureP1363 } = await generateP256KeyAndSignature();
  const signature = decodeIEEEP1363ECDSASignature(p256, signatureP1363);
  const decoded = decodePKIXECDSASignature(signature.encodePKIX());
  expect(decoded.r).toBe(signature.r);
  expect(decoded.s).toBe(signature.s);
});

test("verifyECDSASignature()", async () => {
  const { publicKeySEC1, signatureP1363, data } =
    await generateP256KeyAndSignature();
  const publicKey = decodeSEC1PublicKey(p256, publicKeySEC1);
  const signature = decodeIEEEP1363ECDSASignature(p256, signatureP1363);
  expect(verifyECDSASignature(publicKey, sha256(data), signature)).toBe(true);
  expect(
    verifyECDSASignature(
      publicKey,
      sha256(new TextEncoder().encode("HELLO WORLD")),
      signature,
    ),
  ).toBe(false);
});

test("decodeSEC1PublicKey()", () => {
  const publicKey = new ECDSAPublicKey(p256, p256.g.x, p256.g.y);
  expect(
    decodeSEC1PublicKey(p256, publicKey.encodeSEC1Uncompressed()),
  ).toStrictEqual(publicKey);
  expect(
    decodeSEC1PublicKey(p256, publicKey.encodeSEC1Compressed()),
  ).toStrictEqual(publicKey);
});

describe("ECDSAPublicKey", async () => {
  const data = new TextEncoder().encode("hello world");

  const webcryptoKeys = await crypto.subtle.generateKey(
    {
      name: "ECDSA",
      namedCurve: "P-256",
    },
    true,
    ["sign", "verify"],
  );
  const signature = await crypto.subtle.sign(
    {
      name: "ECDSA",
      hash: "SHA-256",
    },
    webcryptoKeys.privateKey,
    data,
  );

  test("ECDSAPublicKey.encodeSEC1Uncompressed()", async () => {
    const raw1 = new Uint8Array(
      await crypto.subtle.exportKey("raw", webcryptoKeys.publicKey),
    );
    const publicKey = decodeSEC1PublicKey(p256, raw1);
    const raw2 = publicKey.encodeSEC1Uncompressed();
    const webcryptoPublicKey = await crypto.subtle.importKey(
      "raw",
      raw2 as Uint8Array<ArrayBuffer>,
      {
        name: "ECDSA",
        namedCurve: "P-256",
      },
      true,
      ["verify"],
    );
    await expect(
      crypto.subtle.verify(
        {
          name: "ECDSA",
          hash: "SHA-256",
        },
        webcryptoPublicKey,
        signature,
        data,
      ),
    ).resolves.toBe(true);
  });

  test("ECDSAPublicKey.encodeSEC1Compressed()", async () => {
    const raw1 = new Uint8Array(
      await crypto.subtle.exportKey("raw", webcryptoKeys.publicKey),
    );
    const publicKey = decodeSEC1PublicKey(p256, raw1);
    const compressed = publicKey.encodeSEC1Compressed();
    const decompressed = decodeSEC1PublicKey(p256, compressed);
    const webcryptoPublicKey = await crypto.subtle.importKey(
      "raw",
      decompressed.encodeSEC1Uncompressed() as Uint8Array<ArrayBuffer>,
      {
        name: "ECDSA",
        namedCurve: "P-256",
      },
      true,
      ["verify"],
    );
    await expect(
      crypto.subtle.verify(
        {
          name: "ECDSA",
          hash: "SHA-256",
        },
        webcryptoPublicKey,
        signature,
        data,
      ),
    ).resolves.toBe(true);
  });
});

describe("ECDSANamedCurve", () => {
  describe("ECDSANamedCurve.isOnCurve()", () => {
    test("Co-factor h > 1", () => {
      const curve = new ECDSANamedCurve(
        0xdb7c2abf62e35e668076bead208bn,
        0x6127c24c05f38a0aaaf65c0ef02cn,
        0x51def1815db5ed74fcc34c85d709n,
        0x4ba30ab5e892b4e1649dd0928643n,
        0xadcd46f5882e3747def36e956e97n,
        0x36df0aafd8b8d7597ca10520d04bn,
        4n,
        14,
        "1.3.132.0.7",
      );
      expect(
        curve.isOnCurve(
          new ECDSAPoint(
            0x4ba30ab5e892b4e1649dd0928643n,
            0xadcd46f5882e3747def36e956e97n,
          ),
        ),
      ).toBe(true);
      expect(
        curve.isOnCurve(
          new ECDSAPoint(
            3442185213147111329368355265766312n,
            3035790070451486434651648738331985n,
          ),
        ),
      ).toBe(false);
    });
  });
});
