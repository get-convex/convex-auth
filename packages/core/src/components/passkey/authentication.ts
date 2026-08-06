import { Infer, v } from "convex/values";
import { mutation } from "./_generated/server";
import {
  ClientDataType,
  createAssertionSignatureMessage,
  parseAuthenticatorData,
  parseClientDataJSON,
} from "../../vendor/oslo/webauthn";
import {
  decodePKIXECDSASignature,
  decodeSEC1PublicKey,
  p256,
  verifyECDSASignature,
} from "../../vendor/oslo/crypto/ecdsa";
import {
  decodePKCS1RSAPublicKey,
  sha256ObjectIdentifier,
  verifyRSASSAPKCS1v15Signature,
} from "../../vendor/oslo/crypto/rsa";
import { sha256 } from "../../vendor/oslo/crypto/sha2";
import { finishAuthenticationUserError } from "./validation";
import { consumeChallenge, randomChallenge } from "./helpers";

// The challenge and the credential IDs travel as raw bytes (Convex
// `v.bytes()` carries `ArrayBuffer`s end to end). The WebAuthn API in the
// browser makes and accepts the same bytes, so no base64 conversion is
// necessary.
const startAuthenticationResult = v.object({
  challenge: v.bytes(),
  allowCredentials: v.array(v.bytes()),
});

/**
 * Start an authentication ceremony.
 *
 * Set `userId` for the identifier-first flow. The function then attaches
 * the challenge to that user and returns the credential IDs of the user.
 * Pass them to the browser as `allowCredentials`.
 *
 * Do not set `userId` for a discoverable-credential ceremony ("conditional
 * UI" / autocomplete). The challenge then has no identity and
 * `allowCredentials` is empty. The browser offers each resident passkey for
 * the relying party, and the assertion identifies the user.
 */
export const startAuthentication = mutation({
  args: { userId: v.optional(v.string()) },
  returns: startAuthenticationResult,
  handler: async (ctx, { userId }) => {
    const challenge = randomChallenge();
    await ctx.db.insert("challenges", {
      kind: "authentication",
      challenge,
      userId,
      createdAt: Date.now(),
    });
    if (userId === undefined) {
      // Discoverable credentials: no allow-list. The authenticator decides.
      return { challenge, allowCredentials: [] };
    }
    const rows = await ctx.db
      .query("passkeys")
      .withIndex("by_userId", (q) => q.eq("userId", userId))
      .collect();
    return {
      challenge,
      allowCredentials: rows.map((row) => row.credentialId),
    };
  },
});

const finishAuthenticationResult = v.union(
  v.object({
    success: v.literal(true),
    userId: v.string(),
    passkeyId: v.string(),
  }),
  v.object({
    success: v.literal(false),
    userError: finishAuthenticationUserError,
  }),
);
type FinishAuthenticationResult = Infer<typeof finishAuthenticationResult>;

/**
 * Finish an authentication ceremony, as
 * https://webauthn.oslojs.dev/examples/authentication shows.
 *
 * The app supplies `rpId` and `origin`; see `finishRegistration`.
 *
 * The function finds the credential. Then it examines the authenticator
 * data, the client data, and the assertion signature. It deletes the
 * challenge and returns the `userId` of the user. The app can then make a
 * session for that user.
 */
export const finishAuthentication = mutation({
  args: {
    rpId: v.string(),
    origin: v.string(),
    credentialId: v.bytes(),
    authenticatorData: v.bytes(),
    clientDataJSON: v.bytes(),
    signature: v.bytes(),
  },
  returns: finishAuthenticationResult,
  handler: async (ctx, args): Promise<FinishAuthenticationResult> => {
    const passkey = await ctx.db
      .query("passkeys")
      .withIndex("by_credentialId", (q) =>
        q.eq("credentialId", args.credentialId),
      )
      .first();
    if (passkey === null) {
      return { success: false, userError: { error: "UNKNOWN_CREDENTIAL" } };
    }

    const authenticatorDataBytes = new Uint8Array(args.authenticatorData);
    const authenticatorData = parseAuthenticatorData(authenticatorDataBytes);
    if (!authenticatorData.verifyRelyingPartyIdHash(args.rpId)) {
      throw new Error("Relying party ID hash mismatch.");
    }
    if (!authenticatorData.userPresent || !authenticatorData.userVerified) {
      return { success: false, userError: { error: "VERIFICATION_FAILED" } };
    }

    const clientDataJSONBytes = new Uint8Array(args.clientDataJSON);
    const clientData = parseClientDataJSON(clientDataJSONBytes);
    if (clientData.type !== ClientDataType.Get) {
      throw new Error("Unexpected client data type.");
    }
    if (clientData.origin !== args.origin) {
      // For these reasons, we will probably want to offer more customization options
      // for this check in the future.
      throw new Error("Unexpected WebAuthn origin.");
    }
    if (clientData.crossOrigin === true) {
      // In the future, we could allow the user to explicitly opt out to this.
      throw new Error("Cross-origin WebAuthn ceremonies are not allowed.");
    }
    const challengeRow = await consumeChallenge(
      ctx,
      "authentication",
      clientData.challenge,
    );
    if (challengeRow === null) {
      return { success: false, userError: { error: "CHALLENGE_EXPIRED" } };
    }
    // A challenge with a `userId` (the identifier-first flow) must agree
    // with the owner of the credential. A challenge without a `userId` is a
    // discoverable-credential ceremony. In that flow, each registered
    // passkey is acceptable, and the passkey identifies the user.
    if (
      challengeRow.kind === "authentication" &&
      challengeRow.userId !== undefined &&
      challengeRow.userId !== passkey.userId
    ) {
      return { success: false, userError: { error: "VERIFICATION_FAILED" } };
    }

    const hash = sha256(
      createAssertionSignatureMessage(
        authenticatorDataBytes,
        clientDataJSONBytes,
      ),
    );
    const signature = new Uint8Array(args.signature);
    const storedPublicKey = new Uint8Array(passkey.publicKey);
    let valid: boolean;
    if (passkey.algorithm === "ES256") {
      valid = verifyECDSASignature(
        decodeSEC1PublicKey(p256, storedPublicKey),
        hash,
        // WebAuthn ECDSA signatures use the DER (PKIX) encoding.
        decodePKIXECDSASignature(signature),
      );
    } else {
      valid = verifyRSASSAPKCS1v15Signature(
        decodePKCS1RSAPublicKey(storedPublicKey),
        sha256ObjectIdentifier,
        hash,
        signature,
      );
    }
    if (!valid) {
      return { success: false, userError: { error: "VERIFICATION_FAILED" } };
    }

    // TODO: Compare the signature counter with the stored value to find
    // cloned authenticators. Many platform authenticators report 0, so we
    // only store the most recent value here.
    await ctx.db.patch("passkeys", passkey._id, {
      counter: authenticatorData.signatureCounter,
    });
    return {
      success: true,
      userId: passkey.userId,
      passkeyId: passkey._id as string,
    };
  },
});
