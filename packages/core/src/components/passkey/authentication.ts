import { Infer, v } from "convex/values";
import { mutation } from "./_generated/server.ts";
import {
  ClientDataType,
  createAssertionSignatureMessage,
  parseAuthenticatorData,
  parseClientDataJSON,
} from "../../vendor/oslo/webauthn/index.ts";
import {
  decodePKIXECDSASignature,
  decodeSEC1PublicKey,
  p256,
  verifyECDSASignature,
} from "../../vendor/oslo/crypto/ecdsa.ts";
import {
  decodePKCS1RSAPublicKey,
  sha256ObjectIdentifier,
  verifyRSASSAPKCS1v15Signature,
} from "../../vendor/oslo/crypto/rsa.ts";
import { sha256 } from "../../vendor/oslo/crypto/sha2.ts";
import {
  credentialDescriptor,
  finishAuthenticationUserError,
  validatePurpose,
} from "./validation.ts";
import { consumeChallenge, okOrNull, randomChallenge } from "./helpers.ts";
import { scheduleChallengeCleanup } from "./cleanup.ts";

// The challenge and the credential IDs travel as raw bytes (Convex
// `v.bytes()` carries `ArrayBuffer`s end to end). The WebAuthn API in the
// browser makes and accepts the same bytes, so no base64 conversion is
// necessary.
const startAuthenticationResult = v.object({
  challenge: v.bytes(),
  allowCredentials: v.array(credentialDescriptor),
});

/**
 * Start an authentication ceremony.
 *
 * `purpose` binds the challenge to one flow of the app (for example a
 * sign-in, or a re-authentication before a change of a setting). The
 * component does not parse the value. The app chooses the strings; a
 * purpose must be a short string of printable ASCII (see
 * `validatePurpose`).
 *
 * A purpose must be a constant that names the flow, for example
 * "myApp:signIn". Do not put dynamic data in it, such as a user ID, a
 * time, or a nonce.
 *
 * `finishAuthentication` must receive the same purpose. A different
 * purpose gets `PROTOCOL_ERROR`.
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
  args: { purpose: v.string(), userId: v.optional(v.string()) },
  returns: startAuthenticationResult,
  handler: async (ctx, { purpose, userId }) => {
    validatePurpose(purpose);
    const challenge = randomChallenge();
    await ctx.db.insert("challenges", {
      kind: "authentication",
      challenge,
      purpose,
      userId,
    });
    await scheduleChallengeCleanup(ctx);
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
      allowCredentials: rows.map((row) => ({
        id: row.credentialId,
        transports: row.transports,
      })),
    };
  },
});

/**
 * Verify an ES256 assertion signature.
 *
 * @throws on invalid input
 */
function verifyES256Signature(
  storedPublicKey: Uint8Array,
  hash: Uint8Array,
  signature: Uint8Array,
): boolean {
  return verifyECDSASignature(
    decodeSEC1PublicKey(p256, storedPublicKey),
    hash,
    decodePKIXECDSASignature(signature),
  );
}

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
 * The app supplies `expectedRpId` and `expectedOrigin`, as it does for
 * `finishRegistration`.
 *
 * The function finds the credential. Then it examines the authenticator
 * data, the client data, and the assertion signature. It deletes the
 * challenge and returns the `userId` of the user. The app can then make a
 * session for that user.
 *
 * `purpose` must be the purpose that `startAuthentication` received.
 */
export const finishAuthentication = mutation({
  args: {
    purpose: v.string(),
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
    const authenticatorData = okOrNull(() =>
      parseAuthenticatorData(authenticatorDataBytes),
    );
    if (authenticatorData === null) {
      console.warn(
        `Rejected the passkey ceremony: the authenticator data could not be ` +
          `read.`,
      );
      return { success: false, userError: { error: "PROTOCOL_ERROR" } };
    }
    if (!authenticatorData.verifyRelyingPartyIdHash(args.expectedRpId)) {
      console.warn(
        `Rejected the passkey ceremony: the authenticator data does not ` +
          `match the expected relying party ID ${JSON.stringify(args.expectedRpId)}. ` +
          `Check that the \`rpId\` of the provider matches the page that ran ` +
          `the ceremony.`,
      );
      return { success: false, userError: { error: "PROTOCOL_ERROR" } };
    }
    if (!authenticatorData.userPresent || !authenticatorData.userVerified) {
      // The ceremony asks for `userVerification: "required"`, thus
      // `userVerified`/`userPresent` should be set
      console.warn(
        `Rejected the passkey ceremony: the authenticator data reports ` +
          `no user presence or no user verification.`,
      );
      return { success: false, userError: { error: "PROTOCOL_ERROR" } };
    }

    const clientDataJSONBytes = new Uint8Array(args.clientDataJSON);
    const clientData = okOrNull(() => parseClientDataJSON(clientDataJSONBytes));
    if (clientData === null) {
      console.warn(
        `Rejected the passkey ceremony: the client data JSON could not be ` +
          `read.`,
      );
      return { success: false, userError: { error: "PROTOCOL_ERROR" } };
    }
    if (clientData.type !== ClientDataType.Get) {
      console.warn(
        `Rejected the passkey ceremony: the client data type is ` +
          `"webauthn.create", but an authentication ceremony must send ` +
          `"webauthn.get".`,
      );
      return { success: false, userError: { error: "PROTOCOL_ERROR" } };
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
      console.warn(
        `Rejected the passkey ceremony: the ceremony ran at the origin ` +
          `${JSON.stringify(clientData.origin)}, but the expected origin is ` +
          `${JSON.stringify(args.expectedOrigin)}. Check that the \`origin\` of ` +
          `the provider matches the page that ran the ceremony.`,
      );
      return { success: false, userError: { error: "PROTOCOL_ERROR" } };
    }
    if (clientData.crossOrigin === true) {
      // In the future, we could allow the user to explicitly opt out to this.
      console.warn(
        `Rejected the passkey ceremony: the ceremony ran in a cross-origin ` +
          `frame, which is not allowed.`,
      );
      return { success: false, userError: { error: "PROTOCOL_ERROR" } };
    }
    const challengeRow = await consumeChallenge(
      ctx,
      "authentication",
      clientData.challenge,
    );
    if (challengeRow === null) {
      return { success: false, userError: { error: "CHALLENGE_EXPIRED" } };
    }
    if (challengeRow.purpose !== args.purpose) {
      // A client that redeems an assertion in a flow other than the one
      // that asked for it does not respect the protocol. The challenge is
      // consumed at this point: a mismatch comes from the code of the app,
      // so the same ceremony would fail again anyway.
      console.warn(
        `Rejected the passkey ceremony: the challenge was created for the ` +
          `purpose ${JSON.stringify(challengeRow.purpose)}, but the ceremony ` +
          `was finished for the purpose ${JSON.stringify(args.purpose)}.`,
      );
      return { success: false, userError: { error: "PROTOCOL_ERROR" } };
    }
    // A challenge with a `userId` (the identifier-first flow) must agree
    // with the owner of the credential. A challenge without a `userId` is a
    // discoverable-credential ceremony. In that flow, each registered
    // passkey is acceptable, and the passkey identifies the user.
    if (
      challengeRow.userId !== undefined &&
      challengeRow.userId !== passkey.userId
    ) {
      // A challenge with a `userId` always carries the passkeys of that user
      // in `allowCredentials`, thus a compliant client cannot send an
      // assertion from a passkey of a different user.
      console.warn(
        `Rejected the passkey ceremony: the challenge was created for a ` +
          `different user than the owner of the credential.`,
      );
      return { success: false, userError: { error: "PROTOCOL_ERROR" } };
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
      valid =
        okOrNull(() =>
          verifyES256Signature(storedPublicKey, hash, signature),
        ) ?? false;
    } else {
      valid =
        okOrNull(() =>
          verifyRSASSAPKCS1v15Signature(
            decodePKCS1RSAPublicKey(storedPublicKey),
            sha256ObjectIdentifier,
            hash,
            signature,
          ),
        ) ?? false;
    }
    if (!valid) {
      console.warn(
        `Rejected the passkey ceremony: the assertion signature does not ` +
          `match the public key of the credential.`,
      );
      return { success: false, userError: { error: "PROTOCOL_ERROR" } };
    }

    // Here we could compare the signature counter with the stored value to find
    // cloned authenticators. But this would require the app to detect this
    // and using it appropriately, and most authenticators will always set it to 0 anyway.
    // https://www.imperialviolet.org/2023/08/05/signature-counters.html
    // TODO(nicolas) Also record `lastUsedAt` here when the field exists.
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
