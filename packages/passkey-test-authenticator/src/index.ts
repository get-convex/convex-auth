/**
 * A minimal software authenticator for tests. It builds the WebAuthn
 * payloads (client data, authenticator data, attestation objects) and signs
 * assertions with real WebCrypto keys, so a test runs the parsing and the
 * signature verification of a relying party against genuine ceremony bytes.
 */
import {
  decodeBase64url,
  encodeBase64url,
  sha256,
  toDERSignature,
} from "./bytes.ts";
import { encodeCBOR, type CBORValue } from "./cbor.ts";

export { encodeCBOR, type CBORValue };

/**
 * The `RegistrationResponseJSON` wire envelope of a `create()` call, pruned
 * to the fields that the exact validators of a relying party accept.
 */
export type RegistrationResponseEnvelope = {
  id: string;
  rawId: string;
  response: {
    clientDataJSON: string;
    attestationObject: string;
    transports?: string[];
  };
  clientExtensionResults: Record<string, never>;
  type: "public-key";
};

/** The `AuthenticationResponseJSON` wire envelope of a `get()` call. */
export type AuthenticationResponseEnvelope = {
  id: string;
  rawId: string;
  response: {
    clientDataJSON: string;
    authenticatorData: string;
    signature: string;
    userHandle?: string;
  };
  clientExtensionResults: Record<string, never>;
  type: "public-key";
};

/** Encode ceremony bytes the way the JSON wire carries them. */
export function toBase64URL(bytes: Uint8Array | ArrayBuffer): string {
  return encodeBase64url(
    bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes),
  );
}

/**
 * The relying party that the authenticator uses when a caller names none. An
 * app under test has a relying party of its own, thus it passes `rpId` and
 * `origin` to each builder.
 */
export const RP_ID = "example.com";
export const ORIGIN = "https://app.example.com";

export interface TestCredential {
  algorithm: "ES256" | "RS256";
  credentialId: Uint8Array;
  privateKey: CryptoKey;
  cosePublicKey: Uint8Array;
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
      [-1, decodeBase64url(jwk.n!)], // n (256 bytes)
      [-2, decodeBase64url(jwk.e!)], // e (3 bytes)
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
  // Raw challenge bytes, or the base64url string of an options object.
  challenge: ArrayBuffer | Uint8Array | string;
  origin: string;
  crossOrigin?: boolean;
}): Uint8Array {
  const base64url =
    typeof challenge === "string" ? challenge : toBase64URL(challenge);
  return new TextEncoder().encode(
    JSON.stringify({
      type,
      challenge: base64url,
      origin,
      ...(crossOrigin !== undefined ? { crossOrigin } : {}),
    }),
  );
}

export async function buildAuthenticatorData({
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
}): Promise<Uint8Array> {
  let flags = 0;
  if (userPresent) flags |= 0x01;
  if (userVerified) flags |= 0x04;
  if (credential !== undefined) flags |= 0x40;
  const parts: number[] = [
    ...(await sha256(new TextEncoder().encode(rpId))),
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
  message.set(await sha256(clientDataJSON), authenticatorData.length);
  if (credential.algorithm === "ES256") {
    // WebCrypto emits the IEEE P1363 encoding (r || s); WebAuthn transports
    // the DER (PKIX) encoding, which is what a relying party expects.
    return toDERSignature(
      new Uint8Array(
        await crypto.subtle.sign(
          { name: "ECDSA", hash: "SHA-256" },
          credential.privateKey,
          message,
        ),
      ),
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

export function registrationResponse(options: {
  credential: Pick<TestCredential, "credentialId">;
  attestationObject: Uint8Array;
  clientDataJSON: Uint8Array;
  transports?: string[];
}): RegistrationResponseEnvelope {
  const id = toBase64URL(options.credential.credentialId);
  return {
    id,
    rawId: id,
    response: {
      clientDataJSON: toBase64URL(options.clientDataJSON),
      attestationObject: toBase64URL(options.attestationObject),
      ...(options.transports !== undefined
        ? { transports: options.transports }
        : {}),
    },
    clientExtensionResults: {},
    type: "public-key",
  };
}

/** Build the `response` argument of an authentication finish mutation. */
export async function buildAssertion(
  credential: TestCredential,
  challenge: ArrayBuffer | Uint8Array | string,
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
): Promise<{ response: AuthenticationResponseEnvelope }> {
  const clientDataJSON = buildClientDataJSON({
    type: options.type ?? "webauthn.get",
    challenge,
    origin: options.origin ?? ORIGIN,
    crossOrigin: options.crossOrigin,
  });
  const authenticatorData = await buildAuthenticatorData({
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
  const id = toBase64URL(credential.credentialId);
  return {
    // Wrapped in `{ response }`, so tests can spread the result into the
    // arguments of a finish mutation.
    response: {
      id,
      rawId: id,
      response: {
        clientDataJSON: toBase64URL(clientDataJSON),
        authenticatorData: toBase64URL(authenticatorData),
        signature: toBase64URL(signature),
      },
      clientExtensionResults: {},
      type: "public-key",
    },
  };
}
