import { Infer, v } from "convex/values";
import { mutation, query, QueryCtx } from "./_generated/server";
import { Doc, Id } from "./_generated/dataModel";
import { verifyRegistrationResponse } from "@simplewebauthn/server";
import { decodeClientDataJSON } from "@simplewebauthn/server/helpers";
import {
  finishRegistrationUserError,
  FinishRegistrationUserError,
  deletePasskeyUserError,
  SUPPORTED_ALGORITHM_IDS,
} from "./validation";
import {
  deleteDeadChallenge,
  findChallenge,
  isChallengeExpired,
  randomChallenge,
  randomHandle,
  toArrayBuffer,
} from "./helpers";
import { scheduleChallengeCleanup } from "./cleanup";
import {
  vAuthenticatorTransports,
  vRegistrationResponse,
} from "./webauthnJson";

// The challenge, the handle, and the credential IDs are base64url strings:
// that is the encoding SimpleWebAuthn reads and writes on both sides of the
// wire, so nothing here re-encodes them. The caller feeds these values to
// `generateRegistrationOptions`, which owns the rest of the option object.
const startRegistrationResult = v.object({
  challenge: v.string(),
  // The WebAuthn user handle (`user.id`) for the `create()` call.
  userHandle: v.string(),
  excludeCredentials: v.array(
    v.object({
      id: v.string(),
      transports: v.optional(vAuthenticatorTransports),
    }),
  ),
});

/**
 * Start a registration ceremony.
 *
 * The function stores a one-use `registration` challenge and returns the
 * challenge. The challenge has no identity: it is simply a random
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
 * The result is not a complete `PublicKeyCredentialCreationOptionsJSON`.
 * The component deliberately does not see the username that WebAuthn wants
 * in `user.name`, so the caller passes these values to
 * `generateRegistrationOptions` and adds the naming itself.
 *
 * TODO(nicolas) Split this into two methods
 */
export const startRegistration = mutation({
  args: { userId: v.union(v.string(), v.null()) },
  returns: startRegistrationResult,
  handler: async (ctx, { userId }) => {
    let handle: { _id: Id<"handles">; handle: string } | null = null;
    let excludeCredentials: {
      id: string;
      transports?: Infer<typeof vAuthenticatorTransports>;
    }[] = [];
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
      const bytes = await randomHandle();
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

    const challenge = await randomChallenge();
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
  // The whole `startRegistration()` result from `@simplewebauthn/browser`,
  // carried verbatim. `verifyRegistrationResponse` wants the response as the
  // browser built it, so the client does not take it apart.
  response: vRegistrationResponse,
};

const _vRegistrationCheckArgs = v.object(registrationCheckArgs);
type RegistrationCheckArgs = Infer<typeof _vRegistrationCheckArgs>;

type RegistrationChallengeRow = Extract<
  Doc<"challenges">,
  { kind: "registration" }
>;

// The result of `verifyRegistration`. On a `userError`, `challengeRow` is
// the raw challenge row when one exists (live or expired):
// `finishRegistration` burns it. On success, `challengeRow` is the live row.
type RegistrationVerification =
  | {
      userError: FinishRegistrationUserError;
      challengeRow: RegistrationChallengeRow | null;
    }
  | {
      userError: null;
      challengeRow: RegistrationChallengeRow;
      credentialId: string;
      publicKey: ArrayBuffer;
      transports: Infer<typeof vAuthenticatorTransports> | undefined;
      counter: number;
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
 * Failures that the user can correct come back as a `userError`. For a
 * protocol violation, the function throws an error (see
 * `finishRegistration`).
 */
async function verifyRegistration(
  ctx: QueryCtx,
  args: RegistrationCheckArgs,
): Promise<RegistrationVerification> {
  // The client data is read before the signature is checked, for two
  // reasons: the stored challenge has to be found before it can be given to
  // `verifyRegistrationResponse` as the expected one, and an origin
  // mismatch is a deployment mistake that deserves a louder failure than
  // the `userError` that a rejected attestation gets. Neither read is the
  // security boundary — `verifyRegistrationResponse` below checks the
  // challenge, the origin, and the type again over the signed bytes.
  const clientData = decodeClientDataJSON(
    args.response.response.clientDataJSON,
  );
  if (clientData.type !== "webauthn.create") {
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
  const challengeRow = await findChallenge(
    ctx,
    "registration",
    clientData.challenge,
  );
  if (challengeRow === null || isChallengeExpired(challengeRow)) {
    return { userError: { error: "CHALLENGE_EXPIRED" }, challengeRow };
  }

  // Everything protocol-level happens here: the attestation object is
  // decoded, the RP ID hash and the flags are checked, and the COSE public
  // key is extracted. A rejected attestation throws, so the surrounding
  // `catch` is what turns it into a user-facing error.
  let verification;
  try {
    verification = await verifyRegistrationResponse({
      response: args.response,
      expectedChallenge: challengeRow.challenge,
      expectedOrigin: args.expectedOrigin,
      expectedRPID: args.expectedRpId,
      requireUserVerification: true,
      supportedAlgorithmIDs: SUPPORTED_ALGORITHM_IDS,
    });
  } catch (cause) {
    // The message says which check failed (a bad signature, a missing user
    // verification, an unsupported algorithm, …). It is logged rather than
    // returned: the user-facing union stays a small closed set, and the app
    // developer still sees the detail in the Convex logs.
    console.error("Passkey registration was rejected:", cause);
    return { userError: { error: "VERIFICATION_FAILED" }, challengeRow };
  }
  if (!verification.verified) {
    return { userError: { error: "VERIFICATION_FAILED" }, challengeRow };
  }
  const { credential } = verification.registrationInfo;

  const existing = await ctx.db
    .query("passkeys")
    .withIndex("by_credentialId", (q) => q.eq("credentialId", credential.id))
    .first();
  if (existing !== null) {
    // A compliant client cannot cause this: authenticators make a fresh
    // random credential ID for each ceremony, and `excludeCredentials`
    // makes the authenticator refuse a duplicate for this RP. A duplicate
    // here shows a replayed or tampered registration.
    throw new Error("The credential is already registered.");
  }

  return {
    userError: null,
    challengeRow,
    credentialId: credential.id,
    publicKey: toArrayBuffer(credential.publicKey),
    transports: credential.transports,
    counter: credential.counter,
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
 * successful check, and a throw aborts the transaction. The function throws
 * on the same protocol violations that make `finishRegistration` throw, so
 * a caller transaction aborts identically for those.
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
 *
 * `@simplewebauthn/server` examines the attestation. Then this function
 * stores the credential and deletes the challenge.
 *
 * Failures that the user can correct come back as a `userError`. For a
 * protocol violation, the function throws an error. The error aborts the
 * transaction around the call, so a new user row rolls back with it.
 *
 * A caller that must be sure that this call succeeds before it creates
 * data runs `checkRegistration` first, in the same mutation.
 */
export const finishRegistration = mutation({
  args: {
    ...registrationCheckArgs,
    verifiedUserId: v.string(),
    name: v.optional(v.string()),
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
      credentialId: verification.credentialId,
      publicKey: verification.publicKey,
      transports: verification.transports,
      counter: verification.counter,
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
      credentialId: v.string(),
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
