/*
 * Vendored from @oslojs/crypto v1.0.1 (https://github.com/oslo-project/crypto,
 * commit 8b3910f), Copyright (c) 2024 pilcrowOnPaper, MIT license (see LICENSE
 * in this directory). Trimmed to signature verification over the P-256 curve;
 * see README.md.
 */

import { bigIntBytes, bigIntFromBytes } from "../binary";
import {
  ASN1EncodableSequence,
  ASN1Integer,
  encodeASN1,
  parseASN1NoLeftoverBytes,
} from "../asn1";

export function euclideanMod(x: bigint, y: bigint): bigint {
  const r = x % y;
  if (r < 0n) {
    return r + y;
  }
  return r;
}

export function inverseMod(a: bigint, n: bigint): bigint {
  if (n < 0) {
    n = n * -1n;
  }
  if (a < 0) {
    a = euclideanMod(a, n);
  }
  let dividend = a;
  let divisor = n;
  let remainder = dividend % divisor;
  let quotient = dividend / divisor;
  let s1 = 1n;
  let s2 = 0n;
  let s3 = s1 - quotient * s2;
  while (remainder !== 0n) {
    dividend = divisor;
    divisor = remainder;
    s1 = s2;
    s2 = s3;
    remainder = dividend % divisor;
    quotient = dividend / divisor;
    s3 = s1 - quotient * s2;
  }
  if (divisor !== 1n) {
    throw new Error("a and n is not relatively prime");
  }
  if (s2 < 0) {
    return s2 + n;
  }
  return s2;
}

export function powmod(x: bigint, y: bigint, p: bigint): bigint {
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

// assumes p is prime
// https://en.wikipedia.org/wiki/Tonelli–Shanks_algorithm#The_algorithm
export function tonelliShanks(n: bigint, p: bigint): bigint {
  if (p % 4n === 3n) {
    return powmod(n, (p + 1n) / 4n, p);
  }

  if (powmod(n, (p - 1n) / 2n, p) === p - 1n) {
    throw new Error("Cannot find square root");
  }

  let q = p - 1n;
  let s = 0n;
  while (q % 2n === 0n) {
    q = q / 2n;
    s++;
  }

  let z = 2n;
  while (powmod(z, (p - 1n) / 2n, p) !== p - 1n) {
    z++;
  }

  let r = powmod(n, (q + 1n) / 2n, p);
  let t = powmod(n, q, p);
  let c = powmod(z, q, p);
  let m = s;

  while (true) {
    if (t === 1n) {
      return r;
    }
    let i = 1n;
    while (i <= m) {
      if (i === m) {
        throw new Error("Cannot find square root");
      }
      if (powmod(t, 2n ** i, p) === 1n) {
        break;
      }
      i++;
    }
    const b = c ** (2n ** (m - i - 1n));
    m = i;
    c = b ** 2n % p;
    t = (t * b ** 2n) % p;
    r = (r * b) % p;
  }
}

export class ECDSAPoint {
  public x: bigint;
  public y: bigint;

  constructor(x: bigint, y: bigint) {
    this.x = x;
    this.y = y;
  }
}

class JacobianPoint {
  public x: bigint;
  public y: bigint;
  public z: bigint;

  constructor(x: bigint, y: bigint, z: bigint) {
    this.x = x;
    this.y = y;
    this.z = z;
  }

  public isAtInfinity(): boolean {
    return this.x === 0n && this.y === 1n && this.z === 0n;
  }
}

export class ECDSANamedCurve {
  public p: bigint;
  public a: bigint;
  public b: bigint;
  public g: ECDSAPoint;
  public n: bigint;
  public cofactor: bigint;

  public size: number;
  public objectIdentifier: string;

  constructor(
    p: bigint,
    a: bigint,
    b: bigint,
    gx: bigint,
    gy: bigint,
    n: bigint,
    cofactor: bigint,
    size: number,
    objectIdentifier: string,
  ) {
    this.p = p;
    this.a = a;
    this.b = b;
    this.g = new ECDSAPoint(gx, gy);
    this.n = n;
    this.cofactor = cofactor;

    this.size = size;
    this.objectIdentifier = objectIdentifier;
  }

  public add(point1: ECDSAPoint, point2: ECDSAPoint): ECDSAPoint | null {
    const jacobian1 = this.fromAffine(point1);
    const jacobian2 = this.fromAffine(point2);
    return this.toAffine(this.addJacobian(jacobian1, jacobian2));
  }

  private addJacobian(
    point1: JacobianPoint,
    point2: JacobianPoint,
  ): JacobianPoint {
    if (point1.isAtInfinity()) {
      return point2;
    }
    if (point2.isAtInfinity()) {
      return point1;
    }
    const point1zz = point1.z ** 2n;
    const point2zz = point2.z ** 2n;
    const u1 = euclideanMod(point1.x * point2zz, this.p);
    const u2 = euclideanMod(point2.x * point1zz, this.p);
    const s1 = euclideanMod(point1.y * point2zz * point2.z, this.p);
    const s2 = euclideanMod(point2.y * point1zz * point1.z, this.p);
    if (u1 === u2) {
      if (s1 !== s2) {
        return pointAtInfinity();
      }
      return this.doubleJacobian(point1);
    }
    const h = u2 - u1;
    const r = s2 - s1;
    const point3x = euclideanMod(r ** 2n - h ** 3n - 2n * u1 * h ** 2n, this.p);
    const point3 = new JacobianPoint(
      point3x,
      euclideanMod(r * (u1 * h ** 2n - point3x) - s1 * h ** 3n, this.p),
      euclideanMod(h * point1.z * point2.z, this.p),
    );
    return point3;
  }

  public double(point: ECDSAPoint): ECDSAPoint | null {
    const jacobian = this.fromAffine(point);
    return this.toAffine(this.doubleJacobian(jacobian));
  }

  private doubleJacobian(point: JacobianPoint): JacobianPoint {
    if (point.isAtInfinity()) {
      return point;
    }
    if (point.y === 0n) {
      return pointAtInfinity();
    }
    const s = euclideanMod(4n * point.x * point.y ** 2n, this.p);
    const m = euclideanMod(3n * point.x ** 2n + this.a * point.z ** 4n, this.p);
    const resultx = euclideanMod(m ** 2n - 2n * s, this.p);
    const result = new JacobianPoint(
      resultx,
      euclideanMod(m * (s - resultx) - 8n * point.y ** 4n, this.p),
      euclideanMod(2n * point.y * point.z, this.p),
    );
    return result;
  }

  public toAffine(point: JacobianPoint): ECDSAPoint | null {
    if (point.isAtInfinity()) {
      return null;
    }
    const inverseZ = inverseMod(point.z, this.p);
    const inverseZ2 = inverseZ ** 2n;
    const affine = new ECDSAPoint(
      euclideanMod(point.x * inverseZ2, this.p),
      euclideanMod(point.y * inverseZ2 * inverseZ, this.p),
    );
    return affine;
  }

  public fromAffine(point: ECDSAPoint): JacobianPoint {
    return new JacobianPoint(point.x, point.y, 1n);
  }

  // Assumes the point is already on the curve
  public multiply(k: bigint, point: ECDSAPoint): ECDSAPoint | null {
    const kBytes = bigIntBytes(k);
    const bitLength = k.toString(2).length;
    let res = pointAtInfinity();
    let temp = new JacobianPoint(point.x, point.y, 1n);
    for (let i = 0; i < bitLength; i++) {
      const byte = kBytes[kBytes.byteLength - 1 - Math.floor(i / 8)];
      if ((byte >> (i % 8)) & 0x01) {
        res = this.addJacobian(res, temp);
      }
      temp = this.doubleJacobian(temp);
    }
    return this.toAffine(res);
  }

  public isOnCurve(point: ECDSAPoint): boolean {
    // For co-factor h > 1, ensure the point is in the prime order subgroup
    if (this.cofactor !== 1n && this.multiply(this.n, point) !== null) {
      return false;
    }
    return (
      euclideanMod(point.y ** 2n, this.p) ===
      euclideanMod(point.x ** 3n + this.a * point.x + this.b, this.p)
    );
  }
}

function pointAtInfinity(): JacobianPoint {
  return new JacobianPoint(0n, 1n, 0n);
}

// secp256r1, i.e. NIST P-256
export const p256 = new ECDSANamedCurve(
  0xffffffff00000001000000000000000000000000ffffffffffffffffffffffffn,
  0xffffffff00000001000000000000000000000000fffffffffffffffffffffffcn,
  0x5ac635d8aa3a93e7b3ebbd55769886bc651d06b0cc53b0f63bce3c3e27d2604bn,
  0x6b17d1f2e12c4247f8bce6e563a440f277037d812deb33a0f4a13945d898c296n,
  0x4fe342e2fe1a7f9b8ee7eb4a7c0f9e162bce33576b315ececbb6406837bf51f5n,
  0xffffffff00000000ffffffffffffffffbce6faada7179e84f3b9cac2fc632551n,
  1n,
  32,
  "1.2.840.10045.3.1.7",
);

export function verifyECDSASignature(
  publicKey: ECDSAPublicKey,
  hash: Uint8Array,
  signature: ECDSASignature,
): boolean {
  const q = new ECDSAPoint(publicKey.x, publicKey.y);
  if (!publicKey.curve.isOnCurve(q)) {
    return false;
  }
  if (publicKey.curve.multiply(publicKey.curve.n, q) !== null) {
    return false;
  }
  const e = hash.slice(0, publicKey.curve.size);
  const u1 = euclideanMod(
    bigIntFromBytes(e) * inverseMod(signature.s, publicKey.curve.n),
    publicKey.curve.n,
  );
  const u1G = publicKey.curve.multiply(u1, publicKey.curve.g);
  if (u1G === null) {
    return false;
  }
  const u2 = euclideanMod(
    signature.r * inverseMod(signature.s, publicKey.curve.n),
    publicKey.curve.n,
  );
  const u2Q = publicKey.curve.multiply(u2, q);
  if (u2Q === null) {
    return false;
  }
  const coord1 = publicKey.curve.add(u1G, u2Q);
  if (coord1 === null) {
    return false;
  }
  return euclideanMod(signature.r, publicKey.curve.n) === coord1.x;
}

export class ECDSAPublicKey {
  public curve: ECDSANamedCurve;
  public x: bigint;
  public y: bigint;

  constructor(curve: ECDSANamedCurve, x: bigint, y: bigint) {
    this.curve = curve;
    this.x = x;
    this.y = y;
  }

  public encodeSEC1Uncompressed(): Uint8Array {
    const bytes = new Uint8Array(1 + this.curve.size * 2);
    bytes[0] = 0x04;
    const xBytes = bigIntBytes(this.x);
    const yBytes = bigIntBytes(this.y);
    // Both coordinates are right-aligned in their fixed-size slot. `bigIntBytes`
    // omits the leading zero bytes, which happens for about 1 in 256 keys.
    bytes.set(xBytes, 1 + this.curve.size - xBytes.byteLength);
    bytes.set(yBytes, 1 + this.curve.size * 2 - yBytes.byteLength);
    return bytes;
  }

  public encodeSEC1Compressed(): Uint8Array {
    const bytes = new Uint8Array(1 + this.curve.size);
    if (this.y % 2n === 0n) {
      bytes[0] = 0x02;
    } else {
      bytes[0] = 0x03;
    }
    const xBytes = bigIntBytes(this.x);
    bytes.set(xBytes, 1 + this.curve.size - xBytes.byteLength);
    return bytes;
  }
}

export function decodeSEC1PublicKey(
  curve: ECDSANamedCurve,
  bytes: Uint8Array,
): ECDSAPublicKey {
  if (bytes.byteLength < 1) {
    throw new Error("Invalid public key");
  }
  if (bytes[0] === 0x04) {
    if (bytes.byteLength !== curve.size * 2 + 1) {
      throw new Error("Invalid public key");
    }
    const x = bigIntFromBytes(bytes.slice(1, curve.size + 1));
    const y = bigIntFromBytes(bytes.slice(curve.size + 1));
    return new ECDSAPublicKey(curve, x, y);
  }
  if (bytes[0] === 0x02) {
    if (bytes.byteLength !== curve.size + 1) {
      throw new Error("Invalid public key");
    }
    const x = bigIntFromBytes(bytes.slice(1));
    const y2 = euclideanMod(x ** 3n + curve.a * x + curve.b, curve.p);
    const y = tonelliShanks(y2, curve.p);
    if (y % 2n === 0n) {
      return new ECDSAPublicKey(curve, x, y);
    }
    return new ECDSAPublicKey(curve, x, curve.p - y);
  }
  if (bytes[0] === 0x03) {
    if (bytes.byteLength !== curve.size + 1) {
      throw new Error("Invalid public key");
    }
    const x = bigIntFromBytes(bytes.slice(1));
    const y2 = euclideanMod(x ** 3n + curve.a * x + curve.b, curve.p);
    const y = tonelliShanks(y2, curve.p);
    if (y % 2n === 1n) {
      return new ECDSAPublicKey(curve, x, y);
    }
    return new ECDSAPublicKey(curve, x, curve.p - y);
  }
  throw new Error("Unknown encoding format");
}

export class ECDSASignature {
  public r: bigint;
  public s: bigint;

  constructor(r: bigint, s: bigint) {
    if (r < 1n || s < 1n) {
      throw new TypeError("Invalid signature");
    }
    this.r = r;
    this.s = s;
  }

  public encodeIEEEP1363(curve: ECDSANamedCurve): Uint8Array {
    const rs = new Uint8Array(curve.size * 2);
    const rBytes = bigIntBytes(this.r);
    if (rBytes.byteLength > curve.size) {
      throw new Error("'r' is too large");
    }
    const sBytes = bigIntBytes(this.s);
    if (sBytes.byteLength > curve.size) {
      throw new Error("'s' is too large");
    }
    rs.set(rBytes, curve.size - rBytes.byteLength);
    rs.set(sBytes, rs.byteLength - sBytes.byteLength);
    return rs;
  }

  public encodePKIX(): Uint8Array {
    const asn1 = new ASN1EncodableSequence([
      new ASN1Integer(this.r),
      new ASN1Integer(this.s),
    ]);
    return encodeASN1(asn1);
  }
}

export function decodeIEEEP1363ECDSASignature(
  curve: ECDSANamedCurve,
  bytes: Uint8Array,
): ECDSASignature {
  if (bytes.byteLength !== curve.size * 2) {
    throw new Error("Failed to decode signature: Invalid signature size");
  }
  const r = bigIntFromBytes(bytes.slice(0, curve.size));
  const s = bigIntFromBytes(bytes.slice(curve.size));
  return new ECDSASignature(r, s);
}

export function decodePKIXECDSASignature(der: Uint8Array): ECDSASignature {
  try {
    const sequence = parseASN1NoLeftoverBytes(der).sequence();
    return new ECDSASignature(
      sequence.at(0).integer().value,
      sequence.at(1).integer().value,
    );
  } catch {
    throw new Error("Failed to decode signature");
  }
}
