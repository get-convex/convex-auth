import { Infer, v } from "convex/values";
import { mutation, query, QueryCtx } from "./_generated/server.ts";
import { Doc, Id } from "./_generated/dataModel.ts";
import {
  ClientDataType,
  coseAlgorithmES256,
  coseAlgorithmRS256,
  coseEllipticCurveP256,
  parseAttestationObject,
  parseClientDataJSON,
} from "../../vendor/oslo/webauthn/index.ts";
import { ECDSAPublicKey, p256 } from "../../vendor/oslo/crypto/ecdsa.ts";
import { RSAPublicKey } from "../../vendor/oslo/crypto/rsa.ts";
import {
  credentialDescriptor,
  CredentialDescriptor,
  finishRegistrationUserError,
  FinishRegistrationUserError,
  deletePasskeyUserError,
  transportsAreValid,
} from "./validation.ts";
import {
  deleteDeadChallenge,
  findChallenge,
  isChallengeExpired,
  okOrNull,
  randomChallenge,
  randomHandle,
  toArrayBuffer,
} from "./helpers.ts";
import { scheduleChallengeCleanup } from "./cleanup.ts";

// The challenge, the credential IDs, and the user handle travel as raw bytes
// (Convex `v.bytes()` carries `ArrayBuffer`s end to end). The WebAuthn API
// in the browser makes and accepts the same bytes, so no base64 conversion
// is necessary.
const startRegistrationResult = v.object({
  challenge: v.bytes(),
  // The WebAuthn user handle (`user.id`) for the `create()` call.
  userHandle: v.bytes(),
  excludeCredentials: v.array(credentialDescriptor),
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
    let excludeCredentials: CredentialDescriptor[] = [];
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
      excludeCredentials = rows.map((row) => ({
        id: row.credentialId,
        transports: row.transports,
      }));
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

// The arguments that the shared verification helper examines.
const registrationCheckArgs = {
  expectedRpId: v.string(),
  expectedOrigin: v.string(),
  attestationObject: v.bytes(),
  clientDataJSON: v.bytes(),
  transports: v.optional(v.array(v.string())),
};

const _vRegistrationCheckArgs = v.object(registrationCheckArgs);
type RegistrationCheckArgs = Infer<typeof _vRegistrationCheckArgs>;

type RegistrationChallengeDoc = Extract<
  Doc<"challenges">,
  { kind: "registration" }
>;

// The result of `verifyRegistration`. On a `userError`, `challengeRow` is
// the raw challenge row when one exists (live or expired):
// `finishRegistration` burns it. On success, `challengeRow` is the live row.
type RegistrationVerification =
  | {
      userError: FinishRegistrationUserError;
      challengeRow: RegistrationChallengeDoc | null;
    }
  | {
      userError: null;
      challengeRow: RegistrationChallengeDoc;
      credential: VerifiedCredential;
    };

/**
 * The complete verification body of `finishRegistration`, without any
 * write: the client data checks, the challenge lookup with its TTL, the
 * attestation checks, the key extraction, and the duplicate-credential
 * check.
 *
 * The function takes a read-only ctx. `QueryCtx` is structurally satisfied
 * by `MutationCtx`, so both `checkRegistration` (a query) and
 * `finishRegistration` (a mutation) run the exact same code.
 *
 * Failures that the user can correct come back as a `userError`. A client
 * that does not respect the WebAuthn protocol gets `PROTOCOL_ERROR`, and
 * the backend logs say which check failed.
 */
async function verifyRegistration(
  ctx: QueryCtx,
  args: RegistrationCheckArgs,
): Promise<RegistrationVerification> {
  const lookup = await lookupRegistrationChallenge(ctx, args);
  if (lookup.userError !== null) {
    return lookup;
  }
  const verification = await verifyAttestation(ctx, args);
  const { challengeRow } = lookup;
  if (verification.userError !== null) {
    return { userError: verification.userError, challengeRow };
  }
  return { userError: null, challengeRow, credential: verification.credential };
}

async function lookupRegistrationChallenge(
  ctx: QueryCtx,
  args: RegistrationCheckArgs,
): Promise<
  | {
      userError: FinishRegistrationUserError;
      // The challenge that the ceremony names, when it exists. An expired
      // challenge comes back with `CHALLENGE_EXPIRED`, thus the caller can
      // erase it.
      challengeRow: RegistrationChallengeDoc | null;
    }
  | { userError: null; challengeRow: RegistrationChallengeDoc }
> {
  const PROTOCOL_ERROR = {
    userError: { error: "PROTOCOL_ERROR" },
    challengeRow: null,
  } as const;

  if (!transportsAreValid(args.transports)) {
    console.warn(
      `Rejected the passkey ceremony: the client reported transports that seem invalid. The client sent: ${JSON.stringify(args.transports).slice(0, 200)}.`,
    );
    return PROTOCOL_ERROR;
  }
  const clientData = okOrNull(() =>
    parseClientDataJSON(new Uint8Array(args.clientDataJSON)),
  );
  if (clientData === null) {
    console.warn(
      `Rejected the passkey ceremony: the client data JSON could not be read.`,
    );
    return PROTOCOL_ERROR;
  }
  if (clientData.type !== ClientDataType.Create) {
    console.warn(
      `Rejected the passkey ceremony: the client data type is ` +
        `"webauthn.get", but a registration ceremony must send ` +
        `"webauthn.create".`,
    );
    return PROTOCOL_ERROR;
  }
  if (clientData.origin !== args.expectedOrigin) {
    // We could allow this verification to be less strict in the future
    // (see the comment in `finishAuthentication`).
    console.warn(
      `Rejected the passkey ceremony: the ceremony ran at the origin ` +
        `${JSON.stringify(clientData.origin)}, but the expected origin is ` +
        `${JSON.stringify(args.expectedOrigin)}. Check that the \`origin\` of ` +
        `the provider matches the page that ran the ceremony.`,
    );
    return PROTOCOL_ERROR;
  }
  if (clientData.crossOrigin === true) {
    // In the future, we could allow the user to explicitly opt out to this.
    console.warn(
      `Rejected the passkey ceremony: the ceremony ran in a cross-origin ` +
        `frame, which is not allowed.`,
    );
    return PROTOCOL_ERROR;
  }
  const challengeRow = await findChallenge(
    ctx,
    "registration",
    clientData.challenge,
  );
  if (challengeRow === null || isChallengeExpired(challengeRow)) {
    return { userError: { error: "CHALLENGE_EXPIRED" }, challengeRow };
  }
  return { userError: null, challengeRow };
}

// The credential that a verified ceremony carries, ready to store.
type VerifiedCredential = {
  credentialId: ArrayBuffer;
  algorithm: "ES256" | "RS256";
  publicKey: ArrayBuffer;
  counter: number;
};

/**
 * Verifies the WebAuthn attestation sent by the user.
 */
async function verifyAttestation(
  ctx: QueryCtx,
  args: RegistrationCheckArgs,
): Promise<
  | { userError: FinishRegistrationUserError }
  | { userError: null; credential: VerifiedCredential }
> {
  const PROTOCOL_ERROR = { userError: { error: "PROTOCOL_ERROR" } } as const;

  const attestationObject = okOrNull(() =>
    parseAttestationObject(new Uint8Array(args.attestationObject)),
  );
  if (attestationObject === null) {
    console.warn(
      `Rejected the passkey ceremony: the attestation object could not be ` +
        `read.`,
    );
    return PROTOCOL_ERROR;
  }
  const authenticatorData = attestationObject.authenticatorData;
  if (!authenticatorData.verifyRelyingPartyIdHash(args.expectedRpId)) {
    console.warn(
      `Rejected the passkey ceremony: the authenticator data does not match ` +
        `the expected relying party ID ${JSON.stringify(args.expectedRpId)}. ` +
        `Check that the \`rpId\` of the provider matches the page that ran ` +
        `the ceremony.`,
    );
    return PROTOCOL_ERROR;
  }
  if (!authenticatorData.userPresent || !authenticatorData.userVerified) {
    // The ceremony asks for `userVerification: "required"`, thus
    // `userVerified`/`userPresent` should be set
    console.warn(
      `Rejected the passkey ceremony: the authenticator data reports no ` +
        `user presence or no user verification.`,
    );
    return PROTOCOL_ERROR;
  }
  const credential = authenticatorData.credential;
  if (credential === null) {
    console.warn(
      `Rejected the passkey ceremony: the authenticator data carries no ` +
        `attested credential data.`,
    );
    return PROTOCOL_ERROR;
  }

  const cosePublicKey = credential.publicKey;
  // The algorithm is a number, so `null` is never a valid value.
  const coseAlgorithm = okOrNull(() => cosePublicKey.algorithm());
  if (coseAlgorithm === null) {
    console.warn(
      `Rejected the passkey ceremony: the algorithm of the credential public ` +
        `key could not be read.`,
    );
    return PROTOCOL_ERROR;
  }
  let algorithm: "ES256" | "RS256";
  let publicKey: Uint8Array;
  if (coseAlgorithm === coseAlgorithmES256) {
    const ec2 = okOrNull(() => cosePublicKey.ec2());
    if (ec2 === null) {
      console.warn(
        `Rejected the passkey ceremony: the EC2 credential public key could ` +
          `not be read.`,
      );
      return PROTOCOL_ERROR;
    }
    if (ec2.curve !== coseEllipticCurveP256) {
      console.warn(
        `Rejected the passkey ceremony: the credential uses the elliptic ` +
          `curve ${ec2.curve}, but ES256 requires P-256 ` +
          `(${coseEllipticCurveP256}).`,
      );
      return PROTOCOL_ERROR;
    }
    publicKey = new ECDSAPublicKey(p256, ec2.x, ec2.y).encodeSEC1Uncompressed();
    algorithm = "ES256";
  } else if (coseAlgorithm === coseAlgorithmRS256) {
    const rsa = okOrNull(() => cosePublicKey.rsa());
    if (rsa === null) {
      console.warn(
        `Rejected the passkey ceremony: the RSA credential public key could ` +
          `not be read.`,
      );
      return PROTOCOL_ERROR;
    }
    publicKey = new RSAPublicKey(rsa.n, rsa.e).encodePKCS1();
    algorithm = "RS256";
  } else {
    console.warn(
      `Rejected the passkey ceremony: the credential uses the COSE key ` +
        `algorithm ${coseAlgorithm}, but the ceremony only offered ES256 ` +
        `(${coseAlgorithmES256}) and RS256 (${coseAlgorithmRS256}).`,
    );
    return PROTOCOL_ERROR;
  }

  const credentialId = toArrayBuffer(credential.id);
  const existing = await ctx.db
    .query("passkeys")
    .withIndex("by_credentialId", (q) => q.eq("credentialId", credentialId))
    .first();
  if (existing !== null) {
    // A compliant client cannot cause this: authenticators make a fresh
    // random credential ID for each ceremony, and `excludeCredentials`
    // makes the authenticator refuse a duplicate for this RP. A duplicate
    // here shows a replayed or tampered registration.
    console.warn(
      `Rejected the passkey ceremony: the credential is already registered.`,
    );
    return PROTOCOL_ERROR;
  }

  return {
    userError: null,
    credential: {
      credentialId,
      algorithm,
      publicKey: toArrayBuffer(publicKey),
      counter: authenticatorData.signatureCounter,
    },
  };
}

const checkRegistrationResult = v.union(
  v.object({ success: v.literal(true) }),
  v.object({
    success: v.literal(false),
    userError: finishRegistrationUserError,
  }),
);
type CheckRegistrationResult = Infer<typeof checkRegistrationResult>;

/**
 * Run the verifications of `finishRegistration`, without any write.
 *
 * A transactional sign-up flow calls this query first, before it creates
 * the user. Because this is a query, the runtime enforces that nothing is
 * stored: there is no way to store an unverified credential through it.
 *
 * Guarantee: when `checkRegistration` returns `success: true` inside a
 * mutation, a `finishRegistration` call with the same arguments in the
 * same mutation does not return a `userError`. The two calls run in one
 * transaction, so they see the same rows, and Convex fixes the transaction
 * timestamp, so the challenge TTL check cannot flip between the two calls.
 *
 * The guarantee does not cover throws. This function cannot see the
 * handle-linking invariants of `finishRegistration` (they depend on
 * `verifiedUserId`), so `finishRegistration` can still throw after a
 * successful check, and a throw aborts the transaction.
 */
export const checkRegistration = query({
  args: registrationCheckArgs,
  returns: checkRegistrationResult,
  handler: async (ctx, args): Promise<CheckRegistrationResult> => {
    const verification = await verifyRegistration(ctx, args);
    if (verification.userError !== null) {
      return { success: false, userError: verification.userError };
    }
    return { success: true };
  },
});

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
 * - `transports`: the transports that the browser reported for the new
 *   credential. The value is a hint: a later ceremony sends it back to the
 *   browser, and the verification does not use it. A value that no
 *   authenticator can report gets `PROTOCOL_ERROR`.
 *
 * The function examines the attestation as
 * https://webauthn.oslojs.dev/examples/registration shows. Then it stores
 * the credential and deletes the challenge.
 *
 * Each failure comes back as a `userError`. A client that does not respect
 * the WebAuthn protocol gets `PROTOCOL_ERROR`, and the backend logs say
 * which check failed.
 *
 * A caller that must be sure that this call succeeds before it creates
 * data runs `checkRegistration` first, in the same mutation.
 */
export const finishRegistration = mutation({
  args: {
    ...registrationCheckArgs,
    verifiedUserId: v.string(),
    name: v.optional(v.string()),
    transports: v.optional(v.array(v.string())),
  },
  returns: finishRegistrationResult,
  handler: async (ctx, args): Promise<FinishRegistrationResult> => {
    const verification = await verifyRegistration(ctx, args);

    if (verification.userError !== null) {
      // The challenge burns on each finish attempt, also when the
      // verification fails. The ceremony can never complete: the unlinked
      // handle of the ceremony goes away with the challenge.
      if (verification.challengeRow !== null) {
        await deleteDeadChallenge(ctx, verification.challengeRow);
      }
      return { success: false, userError: verification.userError };
    }
    const challengeRow = verification.challengeRow;
    // One use only: the consumed challenge is deleted.
    await ctx.db.delete("challenges", challengeRow._id);

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
      transports: args.transports,
      credentialId: verification.credential.credentialId,
      algorithm: verification.credential.algorithm,
      publicKey: verification.credential.publicKey,
      counter: verification.credential.counter,
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
  // TODO(nicolas) Also return `lastUsedAt` here when the field exists.
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
