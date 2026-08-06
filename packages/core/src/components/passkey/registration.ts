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
 * Start a registration ceremony.
 *
 * The function stores a one-use `registration` challenge and returns the
 * challenge bytes. The challenge has no identity: it is simply a random
 * string used to avoid replay attacks.
 *
 * Set `userId` when a known user adds a passkey to their account. The
 * function then also returns the existing credential IDs of the user.
 * This is used by the authenticator to ensure there isn’t already a
 * passkey that exists for the user.
 */
export const startRegistration = mutation({
  args: { userId: v.optional(v.string()) },
  returns: startRegistrationResult,
  handler: async (ctx, { userId }) => {
    const challenge = randomChallenge();
    await ctx.db.insert("challenges", {
      kind: "registration",
      challenge,
      createdAt: Date.now(),
    });
    let excludeCredentials: ArrayBuffer[] = [];
    if (userId !== undefined) {
      const rows = await ctx.db
        .query("passkeys")
        .withIndex("by_userId", (q) => q.eq("userId", userId))
        .collect();
      excludeCredentials = rows.map((row) => row.credentialId);
    }
    return { challenge, excludeCredentials };
  },
});

const finishRegistrationResult = v.union(
  v.object({ success: v.literal(true), passkeyId: v.string() }),
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
 * - `verifiedUserId`: the user that owns the new passkey. This must always be
 *   the user name of the current user (whether it is a user created in the
 *   same transaction, or the currently logged in user).
 * - `name`: an optional label for the credential. This can be automatically
 *   inferred by the client from the authenticator (e.g. “1Password”),
 *   or provided by the user (e.g. “Nicolas’s MacBook Pro”).
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
    verifiedUserId: v.string(),
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
    if (challengeRow === null) {
      return { success: false, userError: { error: "CHALLENGE_EXPIRED" } };
    }

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
      userId: args.verifiedUserId,
      name: args.name,
      credentialId,
      algorithm,
      publicKey: toArrayBuffer(publicKey),
      counter: authenticatorData.signatureCounter,
    });
    return { success: true, passkeyId };
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
