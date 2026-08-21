/*
 * Vendored from @oslojs/crypto v1.0.1 (https://github.com/oslo-project/crypto,
 * commit 8b3910f), Copyright (c) 2024 pilcrowOnPaper, MIT license (see LICENSE
 * in this directory). Trimmed to RSASSA-PKCS1-v1.5 verification; see README.md.
 */

import { bigIntFromBytes, DynamicBuffer } from "../binary/index.js";
import { constantTimeEqual } from "./subtle.js";
import {
  ASN1EncodableSequence,
  ASN1Integer,
  ASN1Null,
  ASN1ObjectIdentifier,
  ASN1OctetString,
  encodeASN1,
  encodeObjectIdentifier,
  parseASN1NoLeftoverBytes,
} from "../asn1/index.js";

export function verifyRSASSAPKCS1v15Signature(
  publicKey: RSAPublicKey,
  hashObjectIdentifier: string,
  hashed: Uint8Array,
  signature: Uint8Array,
): boolean {
  const s = bigIntFromBytes(signature);
  const m = powmod(s, publicKey.e, publicKey.n);
  const em = new Uint8Array(
    Math.ceil((publicKey.n.toString(2).length - 1) / 8),
  );
  for (let i = 0; i < em.byteLength; i++) {
    em[i] = Number((m >> BigInt((em.byteLength - i - 1) * 8)) & 0xffn);
  }
  const t = encodeASN1(
    new ASN1EncodableSequence([
      new ASN1EncodableSequence([
        new ASN1ObjectIdentifier(encodeObjectIdentifier(hashObjectIdentifier)),
        new ASN1Null(),
      ]),
      new ASN1OctetString(hashed),
    ]),
  );
  if (em.byteLength < t.byteLength + 11) {
    return false;
  }
  const ps = new Uint8Array(em.byteLength - t.byteLength - 3).fill(0xff);
  const emPrime = new DynamicBuffer(0);
  emPrime.writeByte(0x00);
  emPrime.writeByte(0x01);
  emPrime.write(ps);
  emPrime.writeByte(0x00);
  emPrime.write(t);
  return constantTimeEqual(em, emPrime.bytes());
}

export class RSAPublicKey {
  public n: bigint;
  public e: bigint;

  constructor(n: bigint, e: bigint) {
    this.n = n;
    this.e = e;
  }

  public encodePKCS1(): Uint8Array {
    const asn1 = new ASN1EncodableSequence([
      new ASN1Integer(this.n),
      new ASN1Integer(this.e),
    ]);
    return encodeASN1(asn1);
  }
}

export function decodePKCS1RSAPublicKey(pkcs1: Uint8Array): RSAPublicKey {
  try {
    const asn1PublicKey = parseASN1NoLeftoverBytes(pkcs1).sequence();
    return new RSAPublicKey(
      asn1PublicKey.at(0).integer().value,
      asn1PublicKey.at(1).integer().value,
    );
  } catch {
    throw new Error("Invalid public key");
  }
}

export const sha256ObjectIdentifier = "2.16.840.1.101.3.4.2.1";

function powmod(x: bigint, y: bigint, p: bigint): bigint {
  let res = 1n; // Initialize result
  x = x % p;
  while (y > 0) {
    if (y % 2n === 1n) {
      res = euclideanMod(res * x, p);
    }
    y = y >> 1n;
    x = euclideanMod(x * x, p);
  }
  return res;
}

function euclideanMod(x: bigint, y: bigint): bigint {
  const r = x % y;
  if (r < 0n) {
    return r + y;
  }
  return r;
}
