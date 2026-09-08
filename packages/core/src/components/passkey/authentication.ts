import { verifyAuthenticationResponse } from "@simplewebauthn/server";
import { vAuthenticationResponseJSON } from "./validation.ts";
import { isoBase64URL } from "@simplewebauthn/server/helpers";
import { Infer, v } from "convex/values";
import { mutation } from "./_generated/server.ts";
import { scheduleChallengeCleanup } from "./cleanup.ts";
import {
  consumeChallenge,
  randomChallenge,
  toArrayBuffer,
  warnRejectedCeremony,
} from "./helpers.ts";
import {
  credentialDescriptor,
  finishAuthenticationUserError,
  validatePurpose,
} from "./validation.ts";

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
 * {@link validatePurpose}).
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
 * the registration finish functions.
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
    response: vAuthenticationResponseJSON,
  },
  returns: finishAuthenticationResult,
  handler: async (ctx, args): Promise<FinishAuthenticationResult> => {
    validatePurpose(args.purpose);
    const credentialId = toArrayBuffer(
      // args.response contains the credential ID twice: in `args.response.id`
      // and `args.response.rawId`. They are identical by definition (and SimpleWebAuthn
      // checks for their equality), so we can use either one here.
      // Why do we send the same data twice over our wire format? Because our
      // wire format matches the `AuthenticationResponseJSON` DOM type
      // (https://w3c.github.io/webauthn/#dictdef-authenticationresponsejson).
      // Using the DOM type as the wire format makes the implementation easier both on
      // the client (argument serialization is simple) and on the server
      // (SimpleWebAuthn accepts `args.response` directly).
      isoBase64URL.toBuffer(args.response.rawId),
    );
    const passkey = await ctx.db
      .query("passkeys")
      .withIndex("by_credentialId", (q) => q.eq("credentialId", credentialId))
      .first();
    if (passkey === null) {
      return { success: false, userError: { error: "UNKNOWN_CREDENTIAL" } };
    }

    // `verifyAuthenticationResponse` runs every protocol check: the client
    // data type, the origin, the relying party ID hash, the user-presence
    // and user-verification flags, and the assertion signature. The stored
    // key is a COSE key, which names its own algorithm, so there is no
    // ES256/RS256 branch: the verifier reads the algorithm out of the key
    // and picks the verifier. It ignores `crossOrigin`, and only refuses an
    // embedded ceremony when the client sends `topOrigin` (see the note in
    // `registration.ts`).
    //
    // `expectedChallenge` runs during the verification and records here why
    // it accepted or refused the challenge, because the verifier only
    // reports that the challenge did not match.
    type ChallengeOutcome =
      // `expectedChallenge` did not run.
      | "unchecked"
      // The challenge belongs to a row that fits this ceremony.
      | "accepted"
      // No row matches: the challenge expired, or it was already redeemed.
      | "expired"
      // A row matches, but it does not fit this ceremony. The reason is
      // already in the logs.
      | "refused";
    const challenge: { outcome: ChallengeOutcome } = { outcome: "unchecked" };
    let verification;
    try {
      verification = await verifyAuthenticationResponse({
        response: args.response,
        // The callback form receives the challenge that the client data
        // carries, which lets us look its row up while the verification
        // runs. A challenge that is not valid Base64URL makes `toBuffer`
        // throw, and the `catch` clause below reports it.
        expectedChallenge: async (encodedChallenge) => {
          const challengeRow = await consumeChallenge(
            ctx,
            "authentication",
            isoBase64URL.toBuffer(encodedChallenge),
          );
          if (challengeRow === null) {
            challenge.outcome = "expired";
            return false;
          }
          if (challengeRow.purpose !== args.purpose) {
            // A client that redeems an assertion in a flow other than the
            // one that asked for it does not respect the protocol. The
            // challenge is consumed at this point: a mismatch comes from
            // the code of the app, so the same ceremony would fail again
            // anyway.
            warnRejectedCeremony(
              `the challenge was created for the purpose ` +
                `${JSON.stringify(challengeRow.purpose)}, but the ceremony was ` +
                `finished for the purpose ${JSON.stringify(args.purpose)}.`,
            );
            challenge.outcome = "refused";
            return false;
          }
          // A challenge with a `userId` (the identifier-first flow) must
          // agree with the owner of the credential. A challenge without a
          // `userId` is a discoverable-credential ceremony. In that flow,
          // each registered passkey is acceptable, and the passkey
          // identifies the user.
          if (
            challengeRow.userId !== undefined &&
            challengeRow.userId !== passkey.userId
          ) {
            // A challenge with a `userId` always carries the passkeys of
            // that user in `allowCredentials`, thus a compliant client
            // cannot send an assertion from a passkey of a different user.
            warnRejectedCeremony(
              `the challenge was created for a different user than the owner ` +
                `of the credential.`,
            );
            challenge.outcome = "refused";
            return false;
          }
          challenge.outcome = "accepted";
          return true;
        },
        expectedOrigin: args.expectedOrigin,
        expectedRPID: args.expectedRpId,
        credential: {
          id: args.response.rawId,
          publicKey: new Uint8Array(passkey.publicKey),
          // Passkey attestations can carry a counter that can be used by
          // applications to detect duplicated passkeys. The goal is to let
          // applications revoke passkeys that have been tampered with.
          // In this component, we can’t take any sensible action: automatically
          // revoking the passkey could lock the user out of their account,
          // and simply throwing wouldn’t prevent the duplicate owner from
          // issuing valid attestations with a higher counter.
          // So we deliberately provide 0 as if it were the counter value stored
          // in the database, which effectively disables the counter check behavior.
          // See also: https://www.imperialviolet.org/2023/08/05/signature-counters.html
          counter: 0,
          transports: passkey.transports,
        },
        requireUserVerification: true,
      });
    } catch (cause) {
      if (challenge.outcome === "expired") {
        return { success: false, userError: { error: "CHALLENGE_EXPIRED" } };
      }
      if (challenge.outcome === "refused") {
        // `expectedChallenge` already logged the reason.
        return { success: false, userError: { error: "PROTOCOL_ERROR" } };
      }
      // The message of the library names the check that failed: an origin
      // that does not match, a relying party ID hash that does not match, a
      // missing user verification, and so on.
      warnRejectedCeremony(
        `the assertion did not verify. If this happens for every ceremony, ` +
          `check that the \`rpId\` and the \`origin\` of the provider match ` +
          `the page that ran it. ${String(cause)}`,
      );
      return { success: false, userError: { error: "PROTOCOL_ERROR" } };
    }
    if (!verification.verified) {
      warnRejectedCeremony(
        `the assertion signature does not match the public key of the ` +
          `credential.`,
      );
      return { success: false, userError: { error: "PROTOCOL_ERROR" } };
    }
    if (challenge.outcome !== "accepted") {
      // The verifier always asks `expectedChallenge` before it reports a
      // verified assertion. If it does not, the ceremony runs without a
      // challenge check, which allows replays.
      throw new Error("The verified assertion did not check its challenge.");
    }

    // TODO(nicolas) Also record `lastUsedAt` here when the field exists.
    await ctx.db.patch("passkeys", passkey._id, {
      counter: verification.authenticationInfo.newCounter,
    });
    return {
      success: true,
      userId: passkey.userId,
      passkeyId: passkey._id,
    };
  },
});
