import { Infer, v } from "convex/values";
import { mutation } from "./_generated/server";
import { verifyAuthenticationResponse } from "@simplewebauthn/server";
import { decodeClientDataJSON } from "@simplewebauthn/server/helpers";
import { finishAuthenticationUserError } from "./validation";
import { consumeChallenge, randomChallenge } from "./helpers";
import { scheduleChallengeCleanup } from "./cleanup";
import {
  vAuthenticationResponse,
  vAuthenticatorTransports,
} from "./webauthnJson";

// The challenge and the credential IDs are base64url strings, the encoding
// SimpleWebAuthn reads and writes on both sides of the wire. The caller
// feeds these values to `generateAuthenticationOptions`.
const startAuthenticationResult = v.object({
  challenge: v.string(),
  allowCredentials: v.array(
    v.object({
      id: v.string(),
      transports: v.optional(vAuthenticatorTransports),
    }),
  ),
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
    const challenge = await randomChallenge();
    await ctx.db.insert("challenges", {
      kind: "authentication",
      challenge,
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
 * The app supplies `expectedRpId` and `expectedOrigin`; see
 * {@link import("./registration").finishRegistration}.
 *
 * The function finds the credential, hands the assertion to
 * `@simplewebauthn/server` to check the authenticator data, the client
 * data, and the signature, then deletes the challenge and returns the
 * `userId` of the user. The app can then make a session for that user.
 */
export const finishAuthentication = mutation({
  args: {
    expectedRpId: v.string(),
    expectedOrigin: v.string(),
    // The whole `startAuthentication()` result from
    // `@simplewebauthn/browser`, carried verbatim.
    response: vAuthenticationResponse,
  },
  returns: finishAuthenticationResult,
  handler: async (ctx, args): Promise<FinishAuthenticationResult> => {
    const passkey = await ctx.db
      .query("passkeys")
      .withIndex("by_credentialId", (q) =>
        q.eq("credentialId", args.response.id),
      )
      .first();
    if (passkey === null) {
      return { success: false, userError: { error: "UNKNOWN_CREDENTIAL" } };
    }

    // The client data is read before the signature is checked so the stored
    // challenge can be found and given to `verifyAuthenticationResponse` as
    // the expected one, and so an origin mismatch fails loudly as the
    // deployment mistake it is. `verifyAuthenticationResponse` checks the
    // challenge, the origin, and the type again over the signed bytes.
    const clientData = decodeClientDataJSON(
      args.response.response.clientDataJSON,
    );
    if (clientData.type !== "webauthn.get") {
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
      // for this check in the future. `expectedOrigin` already takes an array
      // in `@simplewebauthn/server`, so the list case is a small change.
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
      challengeRow.userId !== undefined &&
      challengeRow.userId !== passkey.userId
    ) {
      return { success: false, userError: { error: "VERIFICATION_FAILED" } };
    }

    // The stored public key is a COSE key, which names its own algorithm, so
    // there is no ES256/RS256 branch here: `verifyAuthenticationResponse`
    // reads the algorithm out of the key and picks the verifier.
    let verification;
    try {
      verification = await verifyAuthenticationResponse({
        response: args.response,
        expectedChallenge: challengeRow.challenge,
        expectedOrigin: args.expectedOrigin,
        expectedRPID: args.expectedRpId,
        credential: {
          id: passkey.credentialId,
          publicKey: new Uint8Array(passkey.publicKey),
          counter: passkey.counter,
          transports: passkey.transports,
        },
        requireUserVerification: true,
      });
    } catch (cause) {
      // Logged rather than returned, so the user-facing union stays a small
      // closed set while the app developer still sees which check failed.
      console.error("Passkey assertion was rejected:", cause);
      return { success: false, userError: { error: "VERIFICATION_FAILED" } };
    }
    if (!verification.verified) {
      return { success: false, userError: { error: "VERIFICATION_FAILED" } };
    }

    // Here we could compare the signature counter with the stored value to find
    // cloned authenticators. But this would require the app to detect this
    // and using it appropriately, and most authenticators will always set it to 0 anyway.
    // https://www.imperialviolet.org/2023/08/05/signature-counters.html
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
