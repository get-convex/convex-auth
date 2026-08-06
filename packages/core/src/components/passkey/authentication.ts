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
 * If `userId` is set, it will force the authentication ceremony to be
 * tied to this particular user. This is necessary in flows where the
 * user is being asked to authenticate to a particular account
 * (e.g. flows where the user enters their username/email, and then
 * is asked to use a passkey for that account).
 *
 * Leaving `userId` unset is useful for ceremonies where the user provides
 * a passkey directly (e.g. “conditional mediation” where the user selects
 * an account in the browser autocompletion list, and it authenticates
 * directly to this account).
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
 * Finish an authentication ceremony.
 *
 * The app supplies `expectedRpId` and `expectedOrigin`; see
 * {@link import("./registration").finishRegistration}.
 *
 * The function finds the credential. Then it examines the authenticator
 * data, the client data, and the assertion signature. It deletes the
 * challenge and returns the `userId` of the user. The app can then make a
 * session for that user.
 */
export const finishAuthentication = mutation({
  args: {
    expectedRpId: v.string(),
    expectedOrigin: v.string(),
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
    if (!authenticatorData.verifyRelyingPartyIdHash(args.expectedRpId)) {
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
    if (clientData.origin !== args.expectedOrigin) {
      // Note: This forces the app to provide a single accepted origin.
      // In some cases, the server might need to accept multiple origins, for instance:
      // - a dev server running on localhost might want to accept all ports
      //   (RP ID = localhost, allowed origin = localhost:*)
      // - an app might want to use origin verification to only allow a specific list
      //   of subdomains (RP ID = example.com, allowed origins =
      //   [auth.example.com, dashboard.example.com] but NOT marketing.example.com)
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

    // Here we could compare the signature counter with the stored value to find
    // cloned authenticators. But this would require the app to detect this
    // and using it appropriately, and most authenticators will always set it to 0 anyway.
    // https://www.imperialviolet.org/2023/08/05/signature-counters.html
    await ctx.db.patch("passkeys", passkey._id, {
      counter: authenticatorData.signatureCounter,
    });
    return {
      success: true,
      userId: passkey.userId,
      passkeyId: passkey._id,
    };
  },
});
