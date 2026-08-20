import type { TestConvex } from "convex-test";
import {
  encodeASN1,
  ASN1EncodableSequence,
  ASN1Integer,
} from "../../vendor/oslo/asn1/index.ts";
import { bigIntFromBytes } from "../../vendor/oslo/binary/index.ts";
import { sha256 } from "../../vendor/oslo/crypto/sha2.ts";
import { decodeBase64urlIgnorePadding } from "../../vendor/oslo/encoding/index.ts";
import { api } from "./_generated/api.ts";
import { toArrayBuffer } from "./helpers.ts";
import type schema from "./schema.ts";

/**
 * A minimal software authenticator for tests. It builds the WebAuthn
 * payloads (client data, authenticator data, attestation objects) and signs
 * assertions with real WebCrypto keys, so the component's parsing and
 * signature verification run against genuine ceremony bytes.
 */

export const RP_ID = "example.com";
export const ORIGIN = "https://app.example.com";

export interface TestCredential {
  algorithm: "ES256" | "RS256";
  credentialId: Uint8Array;
  privateKey: CryptoKey;
  cosePublicKey: Uint8Array;
}

type CBORValue = number | string | Uint8Array | Map<number | string, CBORValue>;

function cborHead(majorType: number, value: number): number[] {
  if (value < 24) {
    return [(majorType << 5) | value];
  }
  if (value < 0x100) {
    return [(majorType << 5) | 24, value];
  }
  if (value < 0x10000) {
    return [(majorType << 5) | 25, value >> 8, value & 0xff];
  }
  throw new Error("Value too large for the test CBOR encoder");
}

/** Encode a small CBOR value (enough for COSE keys and attestation objects). */
export function encodeCBOR(value: CBORValue): Uint8Array {
  const encode = (value: CBORValue): number[] => {
    if (typeof value === "number") {
      return value >= 0 ? cborHead(0, value) : cborHead(1, -1 - value);
    }
    if (typeof value === "string") {
      const bytes = new TextEncoder().encode(value);
      return [...cborHead(3, bytes.length), ...bytes];
    }
    if (value instanceof Uint8Array) {
      return [...cborHead(2, value.length), ...value];
    }
    const out = cborHead(5, value.size);
    for (const [key, entry] of value) {
      out.push(...encode(key), ...encode(entry));
    }
    return out;
  };
  return new Uint8Array(encode(value));
}

export async function generateES256Credential(): Promise<TestCredential> {
  const keyPair = await crypto.subtle.generateKey(
    { name: "ECDSA", namedCurve: "P-256" },
    true,
    ["sign", "verify"],
  );
  // The raw export is a SEC1 uncompressed point: 0x04 || x || y.
  const raw = new Uint8Array(
    await crypto.subtle.exportKey("raw", keyPair.publicKey),
  );
  const cosePublicKey = encodeCBOR(
    new Map<number, CBORValue>([
      [1, 2], // kty: EC2
      [3, -7], // alg: ES256
      [-1, 1], // crv: P-256
      [-2, raw.slice(1, 33)], // x
      [-3, raw.slice(33, 65)], // y
    ]),
  );
  return {
    algorithm: "ES256",
    credentialId: crypto.getRandomValues(new Uint8Array(16)),
    privateKey: keyPair.privateKey,
    cosePublicKey,
  };
}

export async function generateRS256Credential(): Promise<TestCredential> {
  const keyPair = await crypto.subtle.generateKey(
    {
      name: "RSASSA-PKCS1-v1_5",
      modulusLength: 2048,
      publicExponent: new Uint8Array([1, 0, 1]),
      hash: "SHA-256",
    },
    true,
    ["sign", "verify"],
  );
  const jwk = await crypto.subtle.exportKey("jwk", keyPair.publicKey);
  const cosePublicKey = encodeCBOR(
    new Map<number, CBORValue>([
      [1, 3], // kty: RSA
      [3, -257], // alg: RS256
      [-1, decodeBase64urlIgnorePadding(jwk.n!)], // n (256 bytes)
      [-2, decodeBase64urlIgnorePadding(jwk.e!)], // e (3 bytes)
    ]),
  );
  return {
    algorithm: "RS256",
    credentialId: crypto.getRandomValues(new Uint8Array(16)),
    privateKey: keyPair.privateKey,
    cosePublicKey,
  };
}

export function buildClientDataJSON({
  type,
  challenge,
  origin,
  crossOrigin,
}: {
  type: "webauthn.create" | "webauthn.get";
  challenge: ArrayBuffer | Uint8Array;
  origin: string;
  crossOrigin?: boolean;
}): Uint8Array {
  const bytes =
    challenge instanceof Uint8Array ? challenge : new Uint8Array(challenge);
  const base64url = btoa(String.fromCharCode(...bytes))
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replace(/=+$/, "");
  return new TextEncoder().encode(
    JSON.stringify({
      type,
      challenge: base64url,
      origin,
      ...(crossOrigin !== undefined ? { crossOrigin } : {}),
    }),
  );
}

export function buildAuthenticatorData({
  rpId,
  userPresent = true,
  userVerified = true,
  counter = 0,
  credential,
}: {
  rpId: string;
  userPresent?: boolean;
  userVerified?: boolean;
  counter?: number;
  // When set, the attested credential data block is included (AT flag).
  credential?: Pick<TestCredential, "credentialId" | "cosePublicKey">;
}): Uint8Array {
  let flags = 0;
  if (userPresent) flags |= 0x01;
  if (userVerified) flags |= 0x04;
  if (credential !== undefined) flags |= 0x40;
  const parts: number[] = [
    ...sha256(new TextEncoder().encode(rpId)),
    flags,
    (counter >>> 24) & 0xff,
    (counter >>> 16) & 0xff,
    (counter >>> 8) & 0xff,
    counter & 0xff,
  ];
  if (credential !== undefined) {
    parts.push(...new Array(16).fill(0)); // AAGUID
    parts.push(
      (credential.credentialId.length >> 8) & 0xff,
      credential.credentialId.length & 0xff,
    );
    parts.push(...credential.credentialId, ...credential.cosePublicKey);
  }
  return new Uint8Array(parts);
}

export function buildAttestationObject(authData: Uint8Array): Uint8Array {
  return encodeCBOR(
    new Map<string, CBORValue>([
      ["fmt", "none"],
      ["attStmt", new Map()],
      ["authData", authData],
    ]),
  );
}

/** Sign `authenticatorData || sha256(clientDataJSON)` like an authenticator. */
export async function signAssertion(
  credential: TestCredential,
  authenticatorData: Uint8Array,
  clientDataJSON: Uint8Array,
): Promise<Uint8Array> {
  const message = new Uint8Array(authenticatorData.length + 32);
  message.set(authenticatorData);
  message.set(sha256(clientDataJSON), authenticatorData.length);
  if (credential.algorithm === "ES256") {
    // WebCrypto emits the IEEE P1363 encoding (r || s); WebAuthn transports
    // the DER (PKIX) encoding, which is what the component expects.
    const p1363 = new Uint8Array(
      await crypto.subtle.sign(
        { name: "ECDSA", hash: "SHA-256" },
        credential.privateKey,
        message,
      ),
    );
    return encodeASN1(
      new ASN1EncodableSequence([
        new ASN1Integer(bigIntFromBytes(p1363.slice(0, 32))),
        new ASN1Integer(bigIntFromBytes(p1363.slice(32))),
      ]),
    );
  }
  return new Uint8Array(
    await crypto.subtle.sign(
      "RSASSA-PKCS1-v1_5",
      credential.privateKey,
      message,
    ),
  );
}

type T = TestConvex<typeof schema>;

/** Run a full registration ceremony and return the stored credential. */
export async function register(
  t: T,
  userId: string,
  options: {
    name?: string;
    credential?: TestCredential;
    counter?: number;
  } = {},
): Promise<{ credential: TestCredential; passkeyId: string }> {
  const credential = options.credential ?? (await generateES256Credential());
  const { challenge } = await t.mutation(api.registration.startRegistration, {
    userId,
  });
  const authData = buildAuthenticatorData({
    rpId: RP_ID,
    counter: options.counter ?? 0,
    credential,
  });
  const result = await t.mutation(api.registration.finishRegistration, {
    expectedRpId: RP_ID,
    expectedOrigin: ORIGIN,
    verifiedUserId: userId,
    name: options.name,
    attestationObject: toArrayBuffer(buildAttestationObject(authData)),
    clientDataJSON: toArrayBuffer(
      buildClientDataJSON({
        type: "webauthn.create",
        challenge,
        origin: ORIGIN,
      }),
    ),
  });
  if (!result.success) {
    throw new Error(`Test registration failed: ${result.userError.error}`);
  }
  return { credential, passkeyId: result.passkeyId };
}

/** Build the assertion arguments for `finishAuthentication`. */
export async function buildAssertion(
  credential: TestCredential,
  challenge: ArrayBuffer | Uint8Array,
  options: {
    type?: "webauthn.create" | "webauthn.get";
    origin?: string;
    crossOrigin?: boolean;
    rpId?: string;
    counter?: number;
    userPresent?: boolean;
    userVerified?: boolean;
    // Sign with a different key than `credential` (an invalid signature).
    signWith?: TestCredential;
  } = {},
): Promise<{
  credentialId: ArrayBuffer;
  authenticatorData: ArrayBuffer;
  clientDataJSON: ArrayBuffer;
  signature: ArrayBuffer;
}> {
  const clientDataJSON = buildClientDataJSON({
    type: options.type ?? "webauthn.get",
    challenge,
    origin: options.origin ?? ORIGIN,
    crossOrigin: options.crossOrigin,
  });
  const authenticatorData = buildAuthenticatorData({
    rpId: options.rpId ?? RP_ID,
    counter: options.counter ?? 1,
    userPresent: options.userPresent,
    userVerified: options.userVerified,
  });
  const signature = await signAssertion(
    options.signWith ?? credential,
    authenticatorData,
    clientDataJSON,
  );
  return {
    credentialId: toArrayBuffer(credential.credentialId),
    authenticatorData: toArrayBuffer(authenticatorData),
    clientDataJSON: toArrayBuffer(clientDataJSON),
    signature: toArrayBuffer(signature),
  };
}
