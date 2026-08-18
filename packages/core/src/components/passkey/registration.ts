import { Infer, v } from "convex/values";
import { mutation, query } from "./_generated/server";
import { Id } from "./_generated/dataModel";
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
import {
  consumeChallenge,
  deleteUnlinkedHandle,
  randomChallenge,
  randomHandle,
  toArrayBuffer,
} from "./helpers";
import { scheduleChallengeCleanup } from "./cleanup";

// The challenge, the credential IDs, and the user handle travel as raw bytes
// (Convex `v.bytes()` carries `ArrayBuffer`s end to end). The WebAuthn API
// in the browser makes and accepts the same bytes, so no base64 conversion
// is necessary.
const startRegistrationResult = v.object({
  challenge: v.bytes(),
  // The WebAuthn user handle (`user.id`) for the `create()` call.
  userHandle: v.bytes(),
  excludeCredentials: v.array(v.bytes()),
});

/**
 * Start a registration ceremony.
 *
 * The function stores a one-use `registration` challenge and returns the
 * challenge bytes. The challenge has no identity: it is simply a random
 * string used to avoid replay attacks.
 *
 * The function also returns the `userHandle` for the ceremony:
 * - Give a `userId` when a known user adds a passkey to their account. The
 *   function reuses the handle of the user, or makes one when the user has
 *   none. It also returns the existing credential IDs of the user. This is
 *   used by the authenticator to ensure there isn’t already a passkey that
 *   exists for the user.
 * - Give `null` in the new-account flow (the user row does not exist yet).
 *   The function makes a new handle with no user. `finishRegistration` links
 *   the handle to the verified user.
 *
 * The `userId` argument is required, not optional: the two flows behave
 * differently, so the caller must state which flow it runs. (Compare with
 * `startAuthentication`, where the argument is optional.)
 *
 * TODO(nicolas) Split this into two methods
 */
export const startRegistration = mutation({
  args: { userId: v.union(v.string(), v.null()) },
  returns: startRegistrationResult,
  handler: async (ctx, { userId }) => {
    let handle: { _id: Id<"handles">; handle: ArrayBuffer } | null = null;
    let excludeCredentials: ArrayBuffer[] = [];
    if (userId !== null) {
      // A user has a maximum of one handle: reuse it when it exists.
      handle = await ctx.db
        .query("handles")
        .withIndex("by_userId", (q) => q.eq("userId", userId))
        .unique();
      const rows = await ctx.db
        .query("passkeys")
        .withIndex("by_userId", (q) => q.eq("userId", userId))
        .collect();
      excludeCredentials = rows.map((row) => row.credentialId);
    }
    if (handle === null) {
      const bytes = randomHandle();
      // A handle is 64 random bytes, so a collision is not expected. The
      // check is here for safety: two users with the same handle would let
      // one of them authenticate as the other.
      const collision = await ctx.db
        .query("handles")
        .withIndex("by_handle", (q) => q.eq("handle", bytes))
        .first();
      if (collision !== null) {
        throw new Error(
          "The new user handle collides with an existing handle.",
        );
      }
      const id = await ctx.db.insert("handles", { handle: bytes, userId });
      handle = { _id: id, handle: bytes };
    }

    const challenge = randomChallenge();
    await ctx.db.insert("challenges", {
      kind: "registration",
      challenge,
      handleId: handle._id,
    });
    await scheduleChallengeCleanup(ctx);
    return { challenge, userHandle: handle.handle, excludeCredentials };
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
      // The challenge is consumed, so the cleanup loop cannot find the
      // handle later. Remove it here when no user owns it.
      await deleteUnlinkedHandle(ctx, challengeRow.handleId);
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
      // Same as VERIFICATION_FAILED above: the ceremony is burned, so
      // remove the handle when no user owns it.
      await deleteUnlinkedHandle(ctx, challengeRow.handleId);
      return {
        success: false,
        userError: { error: "CREDENTIAL_ALREADY_REGISTERED" },
      };
    }

    // Link the handle of the ceremony to the verified user.
    const handle = await ctx.db.get("handles", challengeRow.handleId);
    if (handle === null) {
      throw new Error("The handle of the challenge does not exist.");
    }
    if (handle.userId === null) {
      // The new-account flow: the handle was made before the user existed.
      const existingHandle = await ctx.db
        .query("handles")
        .withIndex("by_userId", (q) => q.eq("userId", args.verifiedUserId))
        .first();
      if (existingHandle !== null) {
        // Invariant: the new-account flow only runs for a brand-new user,
        // which cannot have a handle already.
        throw new Error(
          "Invariant violation: The user already has a different handle. finishRegistration is being called incorrectly.",
        );
      }
      await ctx.db.patch("handles", handle._id, {
        userId: args.verifiedUserId,
      });
    } else if (handle.userId !== args.verifiedUserId) {
      throw new Error(
        "Invariant violation: The handle belongs to a different user. finishRegistration is being called incorrectly.",
      );
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
 *
 * The function does not delete the handle of the user, not even when the
 * user has no passkeys left. A passkey that the user creates later must
 * reuse the same handle. Then an authenticator that still holds an old
 * credential keeps working, and the user does not fork across two handles.
 * Use `deleteUser` when the user is deleted permanently.
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

/**
 * Delete all the passkey data of a user: their passkeys, their handle, and
 * the authentication challenges bound to the user.
 *
 * The app calls this function when it deletes a user permanently. Do not
 * call it in other cases: without the handle, an authenticator that still
 * holds an old credential stops working (see `deletePasskey`).
 *
 * Caveat: an in-flight registration challenge that points at the handle of
 * the user survives until its TTL. That is safe: `finishRegistration` throws
 * when the handle of the challenge no longer exists, and the cleanup loop
 * erases the challenge after the TTL.
 */
export const deleteUser = mutation({
  args: { userId: v.string() },
  returns: v.null(),
  handler: async (ctx, { userId }) => {
    const passkeys = await ctx.db
      .query("passkeys")
      .withIndex("by_userId", (q) => q.eq("userId", userId))
      .collect();
    for (const passkey of passkeys) {
      await ctx.db.delete("passkeys", passkey._id);
    }
    const handles = await ctx.db
      .query("handles")
      .withIndex("by_userId", (q) => q.eq("userId", userId))
      .collect();
    for (const handle of handles) {
      await ctx.db.delete("handles", handle._id);
    }
    // Only authentication challenges carry a `userId`. Registration rows
    // have no `userId` field, so the index probe never matches them.
    const challenges = await ctx.db
      .query("challenges")
      .withIndex("by_userId", (q) => q.eq("userId", userId))
      .collect();
    for (const challenge of challenges) {
      await ctx.db.delete("challenges", challenge._id);
    }
    return null;
  },
});
