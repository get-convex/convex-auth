/**
 * Server-side WebAuthn ceremony logic for passkey authentication.
 *
 * Handles the four phases of the WebAuthn flow:
 * 1. registerOptions — generate PublicKeyCredentialCreationOptions
 * 2. registerVerify — verify attestation and store credential
 * 3. authOptions — generate PublicKeyCredentialRequestOptions
 * 4. authVerify — verify assertion signature and sign in
 *
 * Uses `@oslojs/webauthn` for attestation/assertion parsing and
 * `@oslojs/crypto` for signature verification.
 *
 * @module
 */

import {
  decodePKIXECDSASignature,
  decodeSEC1PublicKey,
  p256,
  verifyECDSASignature,
} from "@oslojs/crypto/ecdsa";
import {
  decodePKCS1RSAPublicKey,
  RSAPublicKey,
  sha256ObjectIdentifier,
  verifyRSASSAPKCS1v15Signature,
} from "@oslojs/crypto/rsa";
import { sha256 } from "@oslojs/crypto/sha2";
import { decodeBase64urlIgnorePadding, encodeBase64urlNoPadding } from "@oslojs/encoding";
import {
  ClientDataType,
  coseAlgorithmES256,
  coseAlgorithmRS256,
  COSEKeyType,
  createAssertionSignatureMessage,
  parseAttestationObject,
  parseAuthenticatorData,
  parseClientDataJSON,
} from "@oslojs/webauthn";

import type {
  AuthTokens,
  SignInPasskeyOptionsResult,
  SignInSessionResult,
} from "../shared/results";
import { ConvexError } from "convex/values";

import { ErrorCode } from "../shared/codes";
import { authFlowError } from "../shared/errors";
import { authDb } from "./db";
import type { AuthErrorData } from "./errors";
import { toConvexError } from "./errors";
import { emitAuthEvent } from "./events";
import { getAuthenticatedUserIdOrNull } from "./identity/claims";
import { reserveSignInAttempt, resetSignInRateLimit } from "./limits";
import { LOG_LEVELS, log } from "./log";
import { callSignIn, callVerifier } from "./mutations/calls";
import {
  mutatePasskeyInsert,
  mutatePasskeyUpdateCounter,
  mutateVerifierRemove,
  queryPasskeyByCredentialId,
  queryPasskeysByUserId,
  queryUserById,
  queryUserByVerifiedEmail,
  queryVerifierById,
} from "./component/factor/db";
import {
  AuthDataModel,
  GenericActionCtxWithAuthConfig,
  PasskeyProviderConfig,
  SessionInfo,
} from "./types";
import { appUrlFromEnv } from "./url";

type EnrichedActionCtx = GenericActionCtxWithAuthConfig<AuthDataModel>;

interface RpOptions {
  rpName: string;
  rpId: string;
  origin: string | string[];
  attestation: string;
  userVerification: string;
  residentKey: string;
  authenticatorAttachment?: string;
  algorithms: number[];
  challengeExpirationMs: number;
}

type PasskeyResult =
  | SignInSessionResult<SessionInfo<AuthTokens | null> | null>
  | SignInPasskeyOptionsResult;

/**
 * Passkey provider has three single-word flows:
 *
 * - `register` — issue a WebAuthn registration challenge (phase 1).
 * - `signIn`   — issue a WebAuthn authentication challenge (phase 1).
 * - `verify`   — consume the WebAuthn response (phase 2). The server
 *                auto-detects whether this completes a registration
 *                (`attestationObject` present) or a sign-in
 *                (`signature` + `credentialId` present).
 */
const PASSKEY_FLOWS = ["register", "signIn", "verify"] as const;
type PasskeyFlow = (typeof PASSKEY_FLOWS)[number];
type PasskeyDispatch = { flow: PasskeyFlow };

type PasskeyParams = {
  userName?: string;
  userDisplayName?: string;
  email?: string;
  clientDataJSON?: string;
  attestationObject?: string;
  deviceType?: string;
  backedUp?: boolean;
  transports?: string[];
  passkeyName?: string;
  credentialId?: string;
  authenticatorData?: string;
  signature?: string;
};

const requireStringParam = (value: unknown, name: string) => {
  if (typeof value !== "string") {
    throw convexError(ErrorCode.INVALID_PARAMETERS, `Missing \`${name}\` parameter.`);
  }
  return value;
};

const convexError = (code: ErrorCode, message: string) =>
  toConvexError(authFlowError(code, message));

const asConvexError = (
  error: unknown,
  code: ErrorCode,
  message: string,
): ConvexError<AuthErrorData> =>
  error instanceof ConvexError
    ? error
    : error instanceof Error
      ? toConvexError(authFlowError(code, error.message || message))
      : convexError(code, message);

const logPasskeyError = (err: unknown) =>
  log(LOG_LEVELS.ERROR, "passkey error:", err instanceof Error ? err.message : String(err));

function resolveRpOptions(provider: PasskeyProviderConfig): RpOptions {
  try {
    let appUrl: string | undefined;
    if (provider.options.rpId === undefined || provider.options.origin === undefined) {
      try {
        appUrl = appUrlFromEnv();
      } catch {
        throw convexError(
          ErrorCode.PASSKEY_MISSING_CONFIG,
          "Passkey provider requires APP_URL env var (your frontend URL) or explicit rpId and origin in the provider config. CONVEX_SITE_URL cannot be used because WebAuthn RP ID must match the frontend domain.",
        );
      }
    }

    const appHostname = appUrl ? new URL(appUrl).hostname : undefined;
    return {
      rpName: provider.options.rpName ?? appHostname ?? provider.options.rpId ?? "localhost",
      rpId: provider.options.rpId ?? appHostname ?? "localhost",
      origin: provider.options.origin ?? appUrl ?? "http://localhost",
      attestation: provider.options.attestation ?? "none",
      userVerification: provider.options.userVerification ?? "required",
      residentKey: provider.options.residentKey ?? "preferred",
      authenticatorAttachment: provider.options.authenticatorAttachment,
      algorithms: provider.options.algorithms ?? [coseAlgorithmES256, coseAlgorithmRS256],
      challengeExpirationMs: provider.options.challengeExpirationMs ?? 300_000,
    };
  } catch (error) {
    throw asConvexError(
      error,
      ErrorCode.PASSKEY_MISSING_CONFIG,
      "Passkey relying party configuration is invalid.",
    );
  }
}

function verifyClientDataType<T extends { type: ClientDataType }>(
  clientData: T,
  expectedType: ClientDataType,
  label: string,
): T {
  if (clientData.type !== expectedType) {
    throw convexError(
      ErrorCode.PASSKEY_INVALID_CLIENT_DATA,
      `Invalid client data type: expected ${label}`,
    );
  }
  return clientData;
}

function verifyOrigin<T extends { origin: string }>(clientData: T, rp: RpOptions): T {
  const allowed = Array.isArray(rp.origin) ? rp.origin : [rp.origin];
  if (!allowed.includes(clientData.origin)) {
    throw convexError(
      ErrorCode.PASSKEY_INVALID_ORIGIN,
      `Invalid origin: ${clientData.origin}, expected one of: ${allowed.join(", ")}`,
    );
  }
  return clientData;
}

async function verifyAndConsumeChallenge<T extends { challenge: Uint8Array }>(
  clientData: T,
  ctx: EnrichedActionCtx,
  verifierValue: string,
): Promise<T> {
  const challengeHash = encodeBase64urlNoPadding(new Uint8Array(sha256(clientData.challenge)));
  let doc;
  try {
    doc = await queryVerifierById(ctx, verifierValue);
  } catch (err) {
    console.error("[auth] passkey error:", err);
    throw convexError(ErrorCode.PASSKEY_INVALID_CHALLENGE, "Invalid or expired passkey challenge.");
  }
  if (!doc || doc.signature !== challengeHash) {
    throw convexError(ErrorCode.PASSKEY_INVALID_CHALLENGE, "Invalid or expired passkey challenge.");
  }
  try {
    await mutateVerifierRemove(ctx, verifierValue);
  } catch (err) {
    console.error("[auth] passkey error:", err);
    throw convexError(ErrorCode.PASSKEY_INVALID_CHALLENGE, "Invalid or expired passkey challenge.");
  }
  return clientData;
}

function verifyRpId<T extends { verifyRelyingPartyIdHash: (id: string) => boolean }>(
  authData: T,
  rpId: string,
): T {
  if (!authData.verifyRelyingPartyIdHash(rpId)) {
    throw convexError(ErrorCode.PASSKEY_RP_MISMATCH, "Relying party ID mismatch.");
  }
  return authData;
}

function verifyUserFlags<T extends { userPresent: boolean; userVerified: boolean }>(
  authData: T,
  rp: RpOptions,
): T {
  if (!authData.userPresent) {
    throw convexError(ErrorCode.PASSKEY_USER_PRESENCE, "User presence flag not set.");
  }
  if (rp.userVerification === "required" && !authData.userVerified) {
    throw convexError(
      ErrorCode.PASSKEY_USER_VERIFICATION,
      "User verification required but not performed.",
    );
  }
  return authData;
}

function resolvePasskeyDispatch(params: Record<string, unknown>): PasskeyDispatch {
  const flow = params.flow;
  if (typeof flow === "string" && (PASSKEY_FLOWS as readonly string[]).includes(flow)) {
    return { flow: flow as PasskeyFlow };
  }
  throw convexError(
    ErrorCode.PASSKEY_MISSING_FLOW,
    "Missing `flow` parameter. Expected one of: " + PASSKEY_FLOWS.join(", "),
  );
}

function requirePasskeyVerifier(verifier: string | undefined): string {
  if (verifier != null) {
    return verifier;
  }
  throw convexError(ErrorCode.PASSKEY_MISSING_VERIFIER, "Missing verifier for passkey operation.");
}

async function requireAuthenticatedUserId(ctx: EnrichedActionCtx): Promise<string> {
  try {
    const userId = await getAuthenticatedUserIdOrNull(ctx);
    if (userId === null) {
      throw convexError(
        ErrorCode.PASSKEY_AUTH_REQUIRED,
        "Sign in first, then add a passkey to your account.",
      );
    }
    return userId;
  } catch (err) {
    console.error("[auth] passkey error:", err);
    throw convexError(
      ErrorCode.PASSKEY_AUTH_REQUIRED,
      "Sign in first, then add a passkey to your account.",
    );
  }
}

function resolveRegistrationPublicKeyBytes(
  publicKey: NonNullable<
    ReturnType<typeof parseAttestationObject>["authenticatorData"]["credential"]
  >["publicKey"],
  algorithm: number,
): Uint8Array {
  if (algorithm === coseAlgorithmES256) {
    const ec2 = publicKey.ec2();
    const xBytes = new Uint8Array(32);
    let vx = ec2.x;
    for (let i = 31; i >= 0; i--) {
      xBytes[i] = Number(vx & 0xffn);
      vx >>= 8n;
    }
    const yBytes = new Uint8Array(32);
    let vy = ec2.y;
    for (let i = 31; i >= 0; i--) {
      yBytes[i] = Number(vy & 0xffn);
      vy >>= 8n;
    }
    const bytes = new Uint8Array(65);
    bytes[0] = 0x04;
    bytes.set(xBytes, 1);
    bytes.set(yBytes, 33);
    return bytes;
  }
  if (algorithm === coseAlgorithmRS256) {
    const rsa = publicKey.rsa();
    const rsaPubKey = new RSAPublicKey(rsa.n, rsa.e);
    return rsaPubKey.encodePKCS1();
  }
  throw convexError(ErrorCode.PASSKEY_UNSUPPORTED_ALGORITHM, `Unsupported algorithm: ${algorithm}`);
}

function verifyAssertionSignature(
  passkey: Awaited<ReturnType<typeof queryPasskeyByCredentialId>> extends infer T
    ? Exclude<T, null>
    : never,
  signature: Uint8Array,
  messageHash: Uint8Array,
): void {
  if (passkey.algorithm === coseAlgorithmES256) {
    const ecPublicKey = decodeSEC1PublicKey(p256, new Uint8Array(passkey.publicKey));
    const ecdsaSignature = decodePKIXECDSASignature(signature);
    if (!verifyECDSASignature(ecPublicKey, messageHash, ecdsaSignature)) {
      throw convexError(ErrorCode.PASSKEY_INVALID_SIGNATURE, "Invalid passkey signature.");
    }
    return;
  }
  if (passkey.algorithm === coseAlgorithmRS256) {
    const rsaPublicKey = decodePKCS1RSAPublicKey(new Uint8Array(passkey.publicKey));
    if (
      !verifyRSASSAPKCS1v15Signature(rsaPublicKey, sha256ObjectIdentifier, messageHash, signature)
    ) {
      throw convexError(ErrorCode.PASSKEY_INVALID_SIGNATURE, "Invalid passkey signature.");
    }
    return;
  }
  throw convexError(
    ErrorCode.PASSKEY_UNSUPPORTED_ALGORITHM,
    `Unsupported algorithm: ${passkey.algorithm}`,
  );
}

/**
 * Build a deterministic decoy `allowCredentials` list for a passkey `signIn`
 * challenge when the given email has no real passkeys (unknown user, or a user
 * without passkeys).
 *
 * A known email WITH passkeys returns a populated `allowCredentials`, so
 * returning an absent/empty list for every other email would reveal, by the
 * response shape, exactly which accounts exist — an account-enumeration oracle.
 * The decoy ids are derived from a SHA-256 hash of the (trimmed, lowercased)
 * email plus the relying-party id, so the same email always yields the same fake
 * credentials and the response is indistinguishable from a real account.
 *
 * These ids reference no stored credential: the ceremony simply fails to produce
 * an assertion (as it would for a real account whose authenticator is absent),
 * and a forged assertion can never pass {@link verifyAssertionSignature} because
 * no matching credential is ever looked up on `verify`.
 */
function deriveDecoyAllowCredentials(
  email: string,
  rpId: string,
): Array<{ type: "public-key"; id: string; transports?: string[] }> {
  const encoder = new TextEncoder();
  const seed = `convex-auth:passkey-decoy:${rpId}:${email.trim().toLowerCase()}`;
  const base = sha256(encoder.encode(seed));
  // 1–2 decoys, chosen deterministically, mimicking a typical small credential set.
  const count = (base[0] % 2) + 1;
  const credentials: Array<{ type: "public-key"; id: string; transports?: string[] }> = [];
  for (let i = 0; i < count; i++) {
    const idBytes = sha256(encoder.encode(`${seed}:${i}`));
    credentials.push({ type: "public-key" as const, id: encodeBase64urlNoPadding(idBytes) });
  }
  return credentials;
}

/**
 * Drive the passkey provider's `register` / `signIn` / `verify` flow.
 *
 * Dispatches on `args.params.flow`; for `verify` it auto-detects whether the
 * response completes a registration or a sign-in (see {@link PASSKEY_FLOWS}).
 *
 * @param ctx - Auth-enriched action context.
 * @param provider - The resolved passkey provider config (relying-party options).
 * @param args - The flow params and, for `verify`, the issued challenge verifier.
 * @returns A WebAuthn challenge (`passkeyOptions`) or a signed-in session.
 */
export async function handlePasskey(
  ctx: EnrichedActionCtx,
  provider: PasskeyProviderConfig,
  args: {
    params?: Record<string, unknown>;
    verifier?: string;
  },
): Promise<PasskeyResult> {
  const params = (args.params ?? {}) as PasskeyParams;
  const dispatch = resolvePasskeyDispatch(params);

  const handleRegisterVerify = async (): Promise<PasskeyResult> => {
    const userId = await requireAuthenticatedUserId(ctx);
    const rp = resolveRpOptions(provider);
    const verifier = requirePasskeyVerifier(args.verifier);

    const clientDataJSON = decodeBase64urlIgnorePadding(
      requireStringParam(params.clientDataJSON, "clientDataJSON"),
    );
    const clientData = parseClientDataJSON(clientDataJSON);
    verifyClientDataType(clientData, ClientDataType.Create, "webauthn.create");
    verifyOrigin(clientData, rp);
    await verifyAndConsumeChallenge(clientData, ctx, verifier);

    const attestationObjectBytes = decodeBase64urlIgnorePadding(
      requireStringParam(params.attestationObject, "attestationObject"),
    );
    const attestation = parseAttestationObject(attestationObjectBytes);
    const authData = attestation.authenticatorData;
    verifyRpId(authData, rp.rpId);
    verifyUserFlags(authData, rp);

    if (authData.credential == null) {
      throw convexError(ErrorCode.PASSKEY_NO_CREDENTIAL, "No credential in attestation.");
    }

    const credential = authData.credential;
    const credentialId = encodeBase64urlNoPadding(credential.id);
    const publicKey = credential.publicKey;
    const algorithm = publicKey.isAlgorithmDefined()
      ? publicKey.algorithm()
      : publicKey.type() === COSEKeyType.EC2
        ? coseAlgorithmES256
        : publicKey.type() === COSEKeyType.RSA
          ? coseAlgorithmRS256
          : coseAlgorithmES256;
    const publicKeyBytes = resolveRegistrationPublicKeyBytes(publicKey, algorithm);

    try {
      const deviceType = params.deviceType ?? "single-device";
      const backedUp = params.backedUp ?? false;
      const db = authDb(ctx, ctx.auth.config);

      await db.accounts.create({
        userId,
        provider: provider.id,
        providerAccountId: credentialId,
      });

      const passkeyId = await mutatePasskeyInsert(ctx, {
        userId,
        credentialId,
        publicKey: publicKeyBytes.buffer.slice(
          publicKeyBytes.byteOffset,
          publicKeyBytes.byteOffset + publicKeyBytes.byteLength,
        ) as ArrayBuffer,
        algorithm,
        counter: authData.signatureCounter,
        transports: params.transports,
        deviceType,
        backedUp,
        name: params.passkeyName,
        createdAt: Date.now(),
      });
      await emitAuthEvent(ctx, ctx.auth.config, {
        kind: "passkey.added",
        actor: { type: "user", id: userId },
        subject: { type: "passkey", id: passkeyId },
        targets: [{ kind: "user", id: userId }],
        outcome: "success",
        data: { passkeyId, credentialId },
      });
    } catch (err) {
      logPasskeyError(err);
      // Preserve structured failures (e.g. the credentialId-uniqueness guard in
      // `factor.passkey.create` firing when two registrations race the same
      // credential) instead of masking them as a generic internal error.
      if (err instanceof ConvexError) {
        throw err;
      }
      throw convexError(ErrorCode.INTERNAL_ERROR, "An unexpected error occurred.");
    }

    let signInResult;
    try {
      signInResult = await callSignIn(ctx, {
        userId,
        generateTokens: true,
      });
    } catch (error) {
      throw asConvexError(
        error,
        ErrorCode.INTERNAL_ERROR,
        "Failed to finalize passkey registration.",
      );
    }
    return { kind: "signedIn" as const, session: signInResult };
  };

  const handleAuthVerify = async (): Promise<PasskeyResult> => {
    const rp = resolveRpOptions(provider);
    const verifier = requirePasskeyVerifier(args.verifier);

    const clientDataJSON = decodeBase64urlIgnorePadding(
      requireStringParam(params.clientDataJSON, "clientDataJSON"),
    );
    const clientData = parseClientDataJSON(clientDataJSON);
    verifyClientDataType(clientData, ClientDataType.Get, "webauthn.get");
    verifyOrigin(clientData, rp);
    await verifyAndConsumeChallenge(clientData, ctx, verifier);

    const credentialId = params.credentialId;
    if (credentialId == null) {
      throw convexError(ErrorCode.PASSKEY_UNKNOWN_CREDENTIAL, "Missing credential ID");
    }

    let passkey;
    try {
      passkey = await queryPasskeyByCredentialId(ctx, credentialId);
    } catch (err) {
      logPasskeyError(err);
      throw convexError(ErrorCode.PASSKEY_UNKNOWN_CREDENTIAL, "Unknown passkey credential.");
    }
    if (passkey === null) {
      throw convexError(ErrorCode.PASSKEY_UNKNOWN_CREDENTIAL, "Unknown credential");
    }

    // Reserve (consume) a token up front so concurrent guesses cannot all clear
    // a non-consuming check before any failure commits — this is an action, so
    // each runQuery/runMutation is a separate transaction. Refunded on success.
    if (await reserveSignInAttempt(ctx, passkey.userId, ctx.auth.config)) {
      throw convexError(ErrorCode.RATE_LIMITED, "Too many passkey attempts. Try again later.");
    }

    const authenticatorDataBytes = decodeBase64urlIgnorePadding(
      requireStringParam(params.authenticatorData, "authenticatorData"),
    );
    const authenticatorData = parseAuthenticatorData(authenticatorDataBytes);
    const signatureBytes = decodeBase64urlIgnorePadding(
      requireStringParam(params.signature, "signature"),
    );
    const signatureMessage = createAssertionSignatureMessage(
      authenticatorDataBytes,
      clientDataJSON,
    );
    const messageHash = sha256(signatureMessage);

    verifyRpId(authenticatorData, rp.rpId);
    verifyUserFlags(authenticatorData, rp);

    // The reservation above already consumed this attempt's token, so a failed
    // signature or counter check simply propagates. There is no separate
    // failure-record step — running it as its own transaction is exactly what
    // let concurrent guesses slip past the old check-then-record sequence.
    verifyAssertionSignature(passkey, signatureBytes, messageHash);

    if (
      passkey.counter !== 0 &&
      authenticatorData.signatureCounter !== 0 &&
      authenticatorData.signatureCounter <= passkey.counter
    ) {
      throw convexError(
        ErrorCode.PASSKEY_COUNTER_ERROR,
        "Authenticator counter did not increase — possible credential cloning detected.",
      );
    }

    await resetSignInRateLimit(ctx, passkey.userId, ctx.auth.config);

    try {
      await mutatePasskeyUpdateCounter(
        ctx,
        passkey._id,
        authenticatorData.signatureCounter,
        Date.now(),
      );
    } catch (error) {
      throw asConvexError(error, ErrorCode.INTERNAL_ERROR, "Failed to update passkey counter.");
    }

    let signInResult;
    try {
      signInResult = await callSignIn(ctx, {
        userId: passkey.userId,
        generateTokens: true,
      });
    } catch (error) {
      throw asConvexError(error, ErrorCode.INTERNAL_ERROR, "Failed to finalize passkey sign-in.");
    }

    return { kind: "signedIn" as const, session: signInResult };
  };

  const flowHandlers: Record<PasskeyFlow, () => Promise<PasskeyResult>> = {
    register: async () => {
      const userId = await requireAuthenticatedUserId(ctx);
      const rp = resolveRpOptions(provider);

      const challenge = new Uint8Array(32);
      crypto.getRandomValues(challenge);
      const challengeHash = encodeBase64urlNoPadding(new Uint8Array(sha256(challenge)));

      let verifier: string;
      try {
        verifier = await callVerifier(ctx, challengeHash);
      } catch (err) {
        logPasskeyError(err);
        throw convexError(ErrorCode.INTERNAL_ERROR, "An unexpected error occurred.");
      }

      let user;
      try {
        user = await queryUserById(ctx, userId);
      } catch (err) {
        logPasskeyError(err);
        throw convexError(ErrorCode.INTERNAL_ERROR, "An unexpected error occurred.");
      }
      const userName = params.userName ?? user?.email ?? "user";
      const userDisplayName = params.userDisplayName ?? user?.name ?? userName;

      let existing;
      try {
        existing = await queryPasskeysByUserId(ctx, userId);
      } catch (err) {
        logPasskeyError(err);
        throw convexError(ErrorCode.INTERNAL_ERROR, "An unexpected error occurred.");
      }
      const excludeCredentials = existing.map((pk) => ({
        id: pk.credentialId,
        transports: pk.transports,
      }));

      const userHandle = encodeBase64urlNoPadding(new TextEncoder().encode(userId));

      return {
        kind: "passkeyOptions" as const,
        options: {
          rp: { name: rp.rpName, id: rp.rpId },
          user: {
            id: userHandle,
            name: userName,
            displayName: userDisplayName,
          },
          challenge: encodeBase64urlNoPadding(challenge),
          pubKeyCredParams: rp.algorithms.map((alg) => ({
            type: "public-key" as const,
            alg,
          })),
          timeout: rp.challengeExpirationMs,
          attestation: rp.attestation,
          authenticatorSelection: {
            residentKey: rp.residentKey,
            requireResidentKey: rp.residentKey === "required",
            userVerification: rp.userVerification,
            ...(rp.authenticatorAttachment
              ? {
                  authenticatorAttachment: rp.authenticatorAttachment,
                }
              : {}),
          },
          excludeCredentials,
        },
        verifier,
      };
    },

    signIn: async () => {
      const rp = resolveRpOptions(provider);

      const challenge = new Uint8Array(32);
      crypto.getRandomValues(challenge);
      const challengeHash = encodeBase64urlNoPadding(new Uint8Array(sha256(challenge)));

      let verifier: string;
      try {
        verifier = await callVerifier(ctx, challengeHash);
      } catch (err) {
        logPasskeyError(err);
        throw convexError(ErrorCode.INTERNAL_ERROR, "An unexpected error occurred.");
      }

      let allowCredentials:
        | Array<{ type: "public-key"; id: string; transports?: string[] }>
        | undefined;

      if (params.email) {
        const email = requireStringParam(params.email, "email");
        let user;
        try {
          user = await queryUserByVerifiedEmail(ctx, email);
        } catch (err) {
          logPasskeyError(err);
          throw convexError(ErrorCode.INTERNAL_ERROR, "An unexpected error occurred.");
        }
        if (user) {
          let passkeys;
          try {
            passkeys = await queryPasskeysByUserId(ctx, user._id);
          } catch (err) {
            logPasskeyError(err);
            throw convexError(ErrorCode.INTERNAL_ERROR, "An unexpected error occurred.");
          }
          if (passkeys.length > 0) {
            allowCredentials = passkeys.map((pk) => ({
              type: "public-key" as const,
              id: pk.credentialId,
              transports: pk.transports,
            }));
          }
        }
        if (allowCredentials === undefined) {
          // No real passkeys for this email (unknown user, or a user without
          // passkeys). Return deterministic decoys instead of an absent list so
          // the response cannot be used to enumerate which accounts exist.
          allowCredentials = deriveDecoyAllowCredentials(email, rp.rpId);
        }
      }

      const options: {
        challenge: string;
        timeout: number;
        rpId: string;
        userVerification: string;
        allowCredentials?: Array<{
          type: "public-key";
          id: string;
          transports?: string[];
        }>;
      } = {
        challenge: encodeBase64urlNoPadding(challenge),
        timeout: rp.challengeExpirationMs,
        rpId: rp.rpId,
        userVerification: rp.userVerification,
      };

      if (allowCredentials) {
        options.allowCredentials = allowCredentials;
      }

      return {
        kind: "passkeyOptions" as const,
        options,
        verifier,
      };
    },

    verify: async () => {
      const isRegistration =
        typeof params.attestationObject === "string" && params.attestationObject.length > 0;
      const isAuthentication = typeof params.signature === "string" && params.signature.length > 0;

      if (isRegistration && !isAuthentication) {
        return await handleRegisterVerify();
      }
      if (isAuthentication && !isRegistration) {
        return await handleAuthVerify();
      }
      throw convexError(
        ErrorCode.PASSKEY_INVALID_VERIFY,
        "`verify` flow requires either `attestationObject` (to complete a `register`) " +
          "or `signature` + `credentialId` (to complete a `signIn`).",
      );
    },
  };

  const handler = flowHandlers[dispatch.flow];
  if (!handler) {
    throw convexError(ErrorCode.PASSKEY_MISSING_FLOW, `Unknown passkey flow: ${dispatch.flow}`);
  }
  return handler();
}
