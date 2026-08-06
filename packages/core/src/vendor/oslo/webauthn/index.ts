/*
 * Vendored from @oslojs/webauthn v1.0.0 (https://github.com/oslo-project/webauthn,
 * commit c18f664), Copyright (c) 2024 pilcrowOnPaper, MIT license (see LICENSE
 * in this directory). Trimmed to the parts the passkey component uses; see
 * README.md.
 */

import { bigEndian, bigIntFromBytes, compareBytes } from "../binary";
import { decodeBase64urlIgnorePadding } from "../encoding";
import {
  decodeCBORToNativeValue,
  decodeCBORToNativeValueNoLeftoverBytes,
} from "../cbor";
import { sha256 } from "../crypto/sha2";

export function parseClientDataJSON(encoded: Uint8Array): ClientData {
  let parsed: unknown;
  try {
    parsed = JSON.parse(new TextDecoder().decode(encoded));
  } catch {
    throw new ClientDataParseError("Invalid client data JSON");
  }
  if (parsed === null || typeof parsed !== "object") {
    throw new ClientDataParseError("Invalid client data JSON");
  }
  if (!("type" in parsed)) {
    throw new ClientDataParseError("Missing or invalid property 'type'");
  }
  let type: ClientDataType;
  if (parsed.type === "webauthn.get") {
    type = ClientDataType.Get;
  } else if (parsed.type === "webauthn.create") {
    type = ClientDataType.Create;
  } else {
    throw new ClientDataParseError("Missing or invalid property 'type'");
  }
  if (!("challenge" in parsed) || typeof parsed.challenge !== "string") {
    throw new ClientDataParseError("Missing or invalid property 'challenge'");
  }
  let challenge: Uint8Array;
  try {
    challenge = decodeBase64urlIgnorePadding(parsed.challenge);
  } catch {
    throw new ClientDataParseError("Missing or invalid property 'challenge'");
  }

  if (!("origin" in parsed) || typeof parsed.origin !== "string") {
    throw new ClientDataParseError("Missing or invalid property 'origin'");
  }
  let crossOrigin: boolean = false;
  if ("crossOrigin" in parsed) {
    if (typeof parsed.crossOrigin !== "boolean") {
      throw new ClientDataParseError("Invalid property 'crossOrigin'");
    }
    crossOrigin = parsed.crossOrigin;
  }
  let tokenBinding: TokenBinding | null = null;
  if ("tokenBinding" in parsed) {
    if (
      parsed.tokenBinding === null ||
      typeof parsed.tokenBinding !== "object"
    ) {
      throw new ClientDataParseError("Invalid property 'tokenBinding'");
    }
    if (
      !("id" in parsed.tokenBinding) ||
      typeof parsed.tokenBinding.id !== "string"
    ) {
      throw new ClientDataParseError(
        "Missing or invalid property 'tokenBinding.id'",
      );
    }
    if (!("status" in parsed.tokenBinding)) {
      throw new ClientDataParseError(
        "Missing or invalid property 'tokenBinding.status'",
      );
    }

    let tokenBindingId: Uint8Array;
    try {
      tokenBindingId = decodeBase64urlIgnorePadding(parsed.tokenBinding.id);
    } catch {
      throw new ClientDataParseError(
        "Missing or invalid property 'tokenBinding.id'",
      );
    }

    let status: TokenBindingStatus;
    if (parsed.tokenBinding.status === "present") {
      status = TokenBindingStatus.Present;
    } else if (parsed.tokenBinding.status === "supported") {
      status = TokenBindingStatus.Supported;
    } else {
      throw new ClientDataParseError(
        "Missing or invalid property 'tokenBinding.status'",
      );
    }
    tokenBinding = {
      id: tokenBindingId,
      status,
    };
  }
  const clientData: ClientData = {
    type,
    challenge,
    origin: parsed.origin,
    crossOrigin,
    tokenBinding,
  };
  return clientData;
}

export interface ClientData {
  type: ClientDataType;
  challenge: Uint8Array;
  origin: string;
  crossOrigin: boolean | null;
  tokenBinding: TokenBinding | null;
}

export enum ClientDataType {
  Get = 0,
  Create,
}

export interface TokenBinding {
  id: Uint8Array;
  status: TokenBindingStatus;
}

export enum TokenBindingStatus {
  Supported = 0,
  Present,
}

export class ClientDataParseError extends Error {
  constructor(message: string) {
    super(`Failed to parse client data: ${message}`);
  }
}

export function parseAuthenticatorData(encoded: Uint8Array): AuthenticatorData {
  if (encoded.byteLength < 37) {
    throw new AuthenticatorDataParseError("Insufficient bytes");
  }
  const relyingPartyIdHash = encoded.slice(0, 32);
  const flags: AuthenticatorDataFlags = {
    userPresent: (encoded[32] & 0x01) === 1,
    userVerified: ((encoded[32] >> 2) & 0x01) === 1,
  };
  const signatureCounter = bigEndian.uint32(encoded, 33);
  const includesAttestedCredentialData = ((encoded[32] >> 6) & 0x01) === 1;
  let credential: WebAuthnCredential | null = null;
  if (includesAttestedCredentialData) {
    if (encoded.byteLength < 37 + 18) {
      throw new AuthenticatorDataParseError("Invalid credential data");
    }
    const aaguid = encoded.slice(37, 53);
    const credentialIdLength = bigEndian.uint16(encoded, 53);
    if (encoded.byteLength < 37 + 18 + credentialIdLength) {
      throw new AuthenticatorDataParseError("Insufficient bytes");
    }
    const credentialId = encoded.slice(55, 55 + credentialIdLength);
    let credentialPublicKey: COSEPublicKey;
    try {
      [credentialPublicKey] = decodeCOSEPublicKey(
        encoded.slice(55 + credentialIdLength),
      );
    } catch {
      throw new AuthenticatorDataParseError("Failed to parse public key");
    }
    credential = {
      authenticatorAAGUID: aaguid,
      id: credentialId,
      publicKey: credentialPublicKey,
    };
  }
  const authenticatorData = new AuthenticatorData(
    relyingPartyIdHash,
    flags,
    signatureCounter,
    credential,
    null,
  );
  return authenticatorData;
}

export interface AuthenticatorDataFlags {
  userPresent: boolean;
  userVerified: boolean;
}

export class AuthenticatorData {
  public relyingPartyIdHash: Uint8Array;
  public userPresent: boolean;
  public userVerified: boolean;
  public signatureCounter: number;
  public credential: WebAuthnCredential | null;
  public extensions: null;

  constructor(
    relyingPartyIdHash: Uint8Array,
    flags: AuthenticatorDataFlags,
    signatureCounter: number,
    credential: WebAuthnCredential | null,
    extensions: null,
  ) {
    this.relyingPartyIdHash = relyingPartyIdHash;
    this.userPresent = flags.userPresent;
    this.userVerified = flags.userVerified;
    this.signatureCounter = signatureCounter;
    this.credential = credential;
    this.extensions = extensions;
  }

  public verifyRelyingPartyIdHash(relyingPartyId: string): boolean {
    const relyingPartyIdHash = sha256(new TextEncoder().encode(relyingPartyId));
    return compareBytes(this.relyingPartyIdHash, relyingPartyIdHash);
  }
}

export class AuthenticatorDataParseError extends Error {
  constructor(message: string) {
    super(`Failed to parse authenticator data: ${message}`);
  }
}

export interface WebAuthnCredential {
  authenticatorAAGUID: Uint8Array;
  id: Uint8Array;
  publicKey: COSEPublicKey;
}

export function decodeCOSEPublicKey(
  data: Uint8Array,
): [publicKey: COSEPublicKey, size: number] {
  let decoded: unknown;
  let size: number;
  try {
    [decoded, size] = decodeCBORToNativeValue(data, 4);
  } catch {
    throw new Error("Failed to decode CBOR");
  }
  if (typeof decoded !== "object" || decoded === null) {
    throw new Error("Invalid CBOR map");
  }
  return [new COSEPublicKey(decoded), size];
}

export class COSEPublicKey {
  public decoded: object;

  constructor(decoded: object) {
    this.decoded = decoded;
  }

  public type(): COSEKeyType {
    if (!(1 in this.decoded) || typeof this.decoded[1] !== "number") {
      throw new Error("Invalid or missing parameter 'kty'");
    }
    const typeId = this.decoded[1];
    if (typeId in COSE_KEY_ID_MAP) {
      return COSE_KEY_ID_MAP[typeId];
    }
    throw new Error(`Unknown 'kty' value '${typeId}'`);
  }

  public algorithm(): number {
    if (!(3 in this.decoded) || typeof this.decoded[3] !== "number") {
      throw new Error("Invalid or missing parameter 'alg'");
    }
    return this.decoded[3];
  }

  public ec2(): COSEEC2PublicKey {
    if (this.type() !== COSEKeyType.EC2) {
      throw new Error("Expected an elliptic curve public key");
    }

    if (!("-1" in this.decoded) || typeof this.decoded["-1"] !== "number") {
      throw new Error("Invalid or missing parameter 'crv'");
    }

    const curve = this.decoded["-1"];

    if (
      !("-2" in this.decoded) ||
      !(this.decoded["-2"] instanceof Uint8Array)
    ) {
      throw new Error("Invalid or missing parameter 'x'");
    }
    const xBytes = this.decoded["-2"];
    if (xBytes.byteLength !== 32) {
      throw new Error("Invalid or missing parameter 'x'");
    }

    if (
      !("-3" in this.decoded) ||
      !(this.decoded["-3"] instanceof Uint8Array)
    ) {
      throw new Error("Invalid or missing parameter 'y'");
    }
    const yBytes = this.decoded["-3"];
    if (yBytes.byteLength !== 32) {
      throw new Error("Invalid or missing parameter 'y'");
    }

    const publicKey: COSEEC2PublicKey = {
      curve,
      x: bigIntFromBytes(xBytes),
      y: bigIntFromBytes(yBytes),
    };
    return publicKey;
  }

  public rsa(): COSERSAPublicKey {
    if (this.type() !== COSEKeyType.RSA) {
      throw new Error("Expected an RSA public key");
    }

    if (
      !("-1" in this.decoded) ||
      !(this.decoded["-1"] instanceof Uint8Array)
    ) {
      throw new Error("Invalid or missing parameter 'n'");
    }
    const nBytes = this.decoded["-1"];
    if (nBytes.byteLength !== 256) {
      throw new Error("Invalid or missing parameter 'n'");
    }

    if (
      !("-2" in this.decoded) ||
      !(this.decoded["-2"] instanceof Uint8Array)
    ) {
      throw new Error("Invalid or missing parameter 'e'");
    }
    const eBytes = this.decoded["-2"];
    if (eBytes.byteLength !== 3) {
      throw new Error("Invalid or missing parameter 'e'");
    }

    const publicKey: COSERSAPublicKey = {
      n: bigIntFromBytes(nBytes),
      e: bigIntFromBytes(eBytes),
    };
    return publicKey;
  }
}

export interface COSEEC2PublicKey {
  curve: number;
  x: bigint;
  y: bigint;
}

export interface COSERSAPublicKey {
  n: bigint;
  e: bigint;
}

export const coseAlgorithmES256 = -7;
export const coseAlgorithmRS256 = -257;

export const coseEllipticCurveP256 = 1;

export enum COSEKeyType {
  OKP = 0,
  EC2,
  RSA,
  Symmetric,
  HSSLMS,
  WalnutDSA,
}

const COSE_KEY_ID_MAP: Record<number, COSEKeyType> = {
  1: COSEKeyType.OKP,
  2: COSEKeyType.EC2,
  3: COSEKeyType.RSA,
  4: COSEKeyType.Symmetric,
  5: COSEKeyType.HSSLMS,
  6: COSEKeyType.WalnutDSA,
};

export function parseAttestationObject(encoded: Uint8Array): AttestationObject {
  let decoded: unknown;
  try {
    decoded = decodeCBORToNativeValueNoLeftoverBytes(encoded, 4);
  } catch {
    throw new AttestationObjectParseError("Invalid CBOR data");
  }
  if (typeof decoded !== "object" || decoded === null) {
    throw new AttestationObjectParseError("Invalid CBOR data");
  }
  if (!("fmt" in decoded) || typeof decoded.fmt !== "string") {
    throw new AttestationObjectParseError("Invalid or missing property 'fmt'");
  }
  if (
    !("attStmt" in decoded) ||
    typeof decoded.attStmt !== "object" ||
    decoded.attStmt === null
  ) {
    throw new AttestationObjectParseError(
      "Invalid or missing property 'attStmt'",
    );
  }
  if (!("authData" in decoded) || !(decoded.authData instanceof Uint8Array)) {
    throw new AttestationObjectParseError(
      "Invalid or missing property 'authData'",
    );
  }
  let attestationFormat: AttestationStatementFormat;
  if (decoded.fmt === "packed") {
    attestationFormat = AttestationStatementFormat.Packed;
  } else if (decoded.fmt === "tpm") {
    attestationFormat = AttestationStatementFormat.TPM;
  } else if (decoded.fmt === "android-key") {
    attestationFormat = AttestationStatementFormat.AndroidKey;
  } else if (decoded.fmt === "android-safetynet") {
    attestationFormat = AttestationStatementFormat.AndroidSafetyNet;
  } else if (decoded.fmt === "fido-u2f") {
    attestationFormat = AttestationStatementFormat.FIDOU2F;
  } else if (decoded.fmt === "none") {
    attestationFormat = AttestationStatementFormat.None;
  } else if (decoded.fmt === "apple") {
    attestationFormat = AttestationStatementFormat.AppleAnonymous;
  } else {
    throw new AttestationObjectParseError(
      `Unsupported attestation statement format '${decoded.fmt}'`,
    );
  }
  const attestationObject: AttestationObject = {
    authenticatorData: parseAuthenticatorData(decoded.authData),
    attestationStatement: new AttestationStatement(
      attestationFormat,
      decoded.attStmt,
    ),
  };
  return attestationObject;
}

export class AttestationObjectParseError extends Error {
  constructor(message: string) {
    super(`Failed to parse attestation object: ${message}`);
  }
}

export interface AttestationObject {
  attestationStatement: AttestationStatement;
  authenticatorData: AuthenticatorData;
}

export class AttestationStatement {
  public format: AttestationStatementFormat;
  public decoded: object;

  constructor(format: AttestationStatementFormat, decoded: object) {
    this.format = format;
    this.decoded = decoded;
  }
}

export enum AttestationStatementFormat {
  Packed = 0,
  TPM,
  AndroidKey,
  AndroidSafetyNet,
  FIDOU2F,
  AppleAnonymous,
  None,
}

export function createAssertionSignatureMessage(
  authenticatorData: Uint8Array,
  clientDataJSON: Uint8Array,
): Uint8Array {
  const hash = sha256(clientDataJSON);
  const message = new Uint8Array(
    authenticatorData.byteLength + hash.byteLength,
  );
  message.set(authenticatorData);
  message.set(hash, authenticatorData.byteLength);
  return message;
}
