import { Infer, v } from "convex/values";
import { mutation, query } from "./_generated/server";
import {
  ClientDataType,
  coseAlgorithmES256,
  coseAlgorithmRS256,
  coseEllipticCurveP256,
  parseAttestationObject,
  parseClientDataJSON,
} from "../../vendor/oslo/webauthn";
import { ECDSAPublicKey, p256 } from "../../vendor/oslo/crypto/ecdsa";
import { RSAPublicKey } from "../../vendor/oslo/crypto/rsa";
import {
  finishRegistrationUserError,
  deletePasskeyUserError,
} from "./validation";
import { consumeChallenge, randomChallenge, toArrayBuffer } from "./helpers";

// The challenge and the credential IDs travel as raw bytes (Convex
// `v.bytes()` carries `ArrayBuffer`s end to end). The WebAuthn API in the
// browser makes and accepts the same bytes, so no base64 conversion is
// necessary.
const startRegistrationResult = v.object({
  challenge: v.bytes(),
  excludeCredentials: v.array(v.bytes()),
});

/**
 * Start a registration ceremony for the passkey's future owner.
 *
 * The function stores a one-use `registration` challenge and returns the
 * challenge bytes. The challenge records the `userId`, and the finish step
 * reads the owner from the challenge. The app must pass a trusted id: the
 * id of the signed-in user, or the id of a user row that the app created
 * for this registration. A client-supplied id is not safe here, because
 * `finishRegistration` attaches the new passkey to this user.
 *
 * The function also returns the existing credential IDs of the user. The
 * authenticator uses them to refuse a second registration of a passkey
 * that the user already has.
 */
export const startRegistration = mutation({
  args: { userId: v.string() },
  returns: startRegistrationResult,
  handler: async (ctx, { userId }) => {
    const challenge = randomChallenge();
    await ctx.db.insert("challenges", {
      kind: "registration",
      challenge,
      userId,
      createdAt: Date.now(),
    });
    const rows = await ctx.db
      .query("passkeys")
      .withIndex("by_userId", (q) => q.eq("userId", userId))
      .collect();
    return {
      challenge,
      excludeCredentials: rows.map((row) => row.credentialId),
    };
  },
});

const finishRegistrationResult = v.union(
  v.object({
    success: v.literal(true),
    passkeyId: v.string(),
    // The owner of the new passkey, read from the challenge.
    userId: v.string(),
  }),
  v.object({
    success: v.literal(false),
    userError: finishRegistrationUserError,
  }),
);
type FinishRegistrationResult = Infer<typeof finishRegistrationResult>;

/**
 * Finish a registration ceremony.
 *
 * The app supplies:
 * - `expectedRpId`: the expected relying party ID, usually the registrable domain
 *   at which the app is served (for example, "example.com", "subdomain.example.com",
 *   or "localhost"). Only web pages on the same domain (or their subdomains)
 *   will be able to use that passkey.
 *   See https://web.dev/articles/webauthn-rp-id
 * - `expectedOrigin`: the expected origin of the ceremony (for example,
 *   "https://app.example.com").
 * - `name`: an optional label for the credential. This can be automatically
 *   inferred by the client from the authenticator (e.g. “1Password”),
 *   or provided by the user (e.g. “Nicolas’s MacBook Pro”).
 *
 * The owner of the new passkey is not an argument. The function reads it
 * from the challenge, where `startRegistration` stored it. This keeps the
 * owner a server-side, trusted value: a client cannot attach its ceremony
 * to a different user. The result contains the owner's `userId`.
 *
 * The function examines the attestation as
 * https://webauthn.oslojs.dev/examples/registration shows. Then it stores
 * the credential and deletes the challenge.
 *
 * Failures that the user can correct come back as a `userError`. For a
 * protocol violation, the function throws an error. The error aborts the
 * transaction around the call, so a new user row rolls back with it.
 */
export const finishRegistration = mutation({
  args: {
    expectedRpId: v.string(),
    expectedOrigin: v.string(),
    name: v.optional(v.string()),
    attestationObject: v.bytes(),
    clientDataJSON: v.bytes(),
  },
  returns: finishRegistrationResult,
  handler: async (ctx, args): Promise<FinishRegistrationResult> => {
    const clientData = parseClientDataJSON(new Uint8Array(args.clientDataJSON));
    if (clientData.type !== ClientDataType.Create) {
      throw new Error("Unexpected client data type.");
    }
    if (clientData.origin !== args.expectedOrigin) {
      // We could allow this verification to be less strict in the future
      // (see the comment in `finishAuthentication`).
      throw new Error("Unexpected WebAuthn origin.");
    }
    if (clientData.crossOrigin === true) {
      // In the future, we could allow the user to explicitly opt out to this.
      throw new Error("Cross-origin WebAuthn ceremonies are not allowed.");
    }
    const challengeRow = await consumeChallenge(
      ctx,
      "registration",
      clientData.challenge,
    );
    if (challengeRow === null || challengeRow.kind !== "registration") {
      return { success: false, userError: { error: "CHALLENGE_EXPIRED" } };
    }
    // The trusted owner of the new passkey (see the function comment).
    const userId = challengeRow.userId;

    const attestationObject = parseAttestationObject(
      new Uint8Array(args.attestationObject),
    );
    const authenticatorData = attestationObject.authenticatorData;
    if (!authenticatorData.verifyRelyingPartyIdHash(args.expectedRpId)) {
      throw new Error("Relying party ID hash mismatch.");
    }
    if (!authenticatorData.userPresent || !authenticatorData.userVerified) {
      return { success: false, userError: { error: "VERIFICATION_FAILED" } };
    }
    const credential = authenticatorData.credential;
    if (credential === null) {
      throw new Error("Missing attested credential data.");
    }

    const cosePublicKey = credential.publicKey;
    let algorithm: "ES256" | "RS256";
    let publicKey: Uint8Array;
    if (cosePublicKey.algorithm() === coseAlgorithmES256) {
      const ec2 = cosePublicKey.ec2();
      if (ec2.curve !== coseEllipticCurveP256) {
        throw new Error("Unsupported elliptic curve (expected P-256).");
      }
      publicKey = new ECDSAPublicKey(
        p256,
        ec2.x,
        ec2.y,
      ).encodeSEC1Uncompressed();
      algorithm = "ES256";
    } else if (cosePublicKey.algorithm() === coseAlgorithmRS256) {
      const rsa = cosePublicKey.rsa();
      publicKey = new RSAPublicKey(rsa.n, rsa.e).encodePKCS1();
      algorithm = "RS256";
    } else {
      throw new Error("Unsupported public key algorithm.");
    }

    const credentialId = toArrayBuffer(credential.id);
    const existing = await ctx.db
      .query("passkeys")
      .withIndex("by_credentialId", (q) => q.eq("credentialId", credentialId))
      .first();
    if (existing !== null) {
      return {
        success: false,
        userError: { error: "CREDENTIAL_ALREADY_REGISTERED" },
      };
    }

    const passkeyId = await ctx.db.insert("passkeys", {
      userId,
      name: args.name,
      credentialId,
      algorithm,
      publicKey: toArrayBuffer(publicKey),
      counter: authenticatorData.signatureCounter,
    });
    return { success: true, passkeyId, userId };
  },
});

/**
 * List the registered passkeys of a user, for example for a settings page.
 * The function returns only public metadata. It does not return the public
 * keys or the counters.
 */
export const listPasskeys = query({
  args: { userId: v.string() },
  returns: v.array(
    v.object({
      passkeyId: v.string(),
      name: v.optional(v.string()),
      credentialId: v.bytes(),
      createdAt: v.number(),
    }),
  ),
  handler: async (ctx, { userId }) => {
    const rows = await ctx.db
      .query("passkeys")
      .withIndex("by_userId", (q) => q.eq("userId", userId))
      .collect();
    return rows.map((row) => ({
      passkeyId: row._id,
      name: row.name,
      credentialId: row.credentialId,
      createdAt: row._creationTime,
    }));
  },
});

const deletePasskeyResult = v.union(
  v.object({ success: v.literal(true) }),
  v.object({ success: v.literal(false), userError: deletePasskeyUserError }),
);
type DeletePasskeyResult = Infer<typeof deletePasskeyResult>;

/**
 * Delete one passkey of `userId`.
 *
 * The `userId` check makes the function safe for an ID that comes directly
 * from the client: a user can only delete their own passkeys.
 */
export const deletePasskey = mutation({
  args: { userId: v.string(), passkeyId: v.string() },
  returns: deletePasskeyResult,
  handler: async (ctx, { userId, passkeyId }): Promise<DeletePasskeyResult> => {
    const id = ctx.db.normalizeId("passkeys", passkeyId);
    if (id === null) {
      return { success: false, userError: { error: "PASSKEY_NOT_FOUND" } };
    }
    const row = await ctx.db.get("passkeys", id);
    if (row === null || row.userId !== userId) {
      return { success: false, userError: { error: "PASSKEY_NOT_FOUND" } };
    }
    await ctx.db.delete("passkeys", id);
    return { success: true };
  },
});
