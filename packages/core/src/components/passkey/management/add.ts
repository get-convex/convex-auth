import { mutationGeneric } from "convex/server";
import { Infer, v } from "convex/values";
import { getAuthUserId } from "../../core/userId.ts";
import { ADD_PASSKEY_PURPOSE } from "../purposes.ts";
import type { UsernamePasskeyConfig } from "../setup.ts";
import {
  credentialDescriptor,
  finishAuthenticationUserError,
  finishRegistrationUserError,
  notSignedInUserError,
} from "../validation.ts";

const startAddPasskeyResult = v.union(
  v.object({
    success: v.literal(true),
    challenge: v.bytes(),
    allowCredentials: v.array(credentialDescriptor),
    rpId: v.string(),
  }),
  v.object({ success: v.literal(false), userError: notSignedInUserError }),
);

/**
 * The result of `startAddPasskey`: the data for a `get()` call that
 * re-authenticates the user, or a user-facing `userError`.
 */
export type StartAddPasskeyResult = Infer<typeof startAddPasskeyResult>;

const verifyAddPasskeyResult = v.union(
  v.object({
    success: v.literal(true),
    challenge: v.bytes(),
    // The WebAuthn user handle (`user.id`) for the `create()` call.
    userHandle: v.bytes(),
    excludeCredentials: v.array(credentialDescriptor),
    rpId: v.string(),
    rpName: v.string(),
    // The WebAuthn `user.name` and `user.displayName` for the `create()`
    // call. `null` when the app removed the username of the user; then the
    // client chooses what to show.
    username: v.union(v.string(), v.null()),
  }),
  v.object({
    success: v.literal(false),
    userError: v.union(notSignedInUserError, finishAuthenticationUserError),
  }),
);

/**
 * The result of `verifyAddPasskey`: the data for the `create()` call that
 * makes the new passkey, or a user-facing `userError`.
 */
export type VerifyAddPasskeyResult = Infer<typeof verifyAddPasskeyResult>;

const finishAddPasskeyResult = v.union(
  v.object({ success: v.literal(true), passkeyId: v.string() }),
  v.object({
    success: v.literal(false),
    userError: v.union(notSignedInUserError, finishRegistrationUserError),
  }),
);

/**
 * The result of `finishAddPasskey`: the ID of the stored passkey, or a
 * user-facing `userError`.
 */
export type FinishAddPasskeyResult = Infer<typeof finishAddPasskeyResult>;

/**
 * Build the `startAddPasskey` mutation of the provider.
 *
 * The user must prove again that they hold a passkey of the account before
 * they add one. The mutation starts that re-authentication ceremony. Each
 * passkey of the user is acceptable, thus `allowCredentials` holds all of
 * them.
 */
export function startAddPasskey(config: UsernamePasskeyConfig) {
  return mutationGeneric({
    args: {},
    returns: startAddPasskeyResult,
    handler: async (ctx): Promise<StartAddPasskeyResult> => {
      const userId = await getAuthUserId(ctx);
      if (userId === null) {
        return { success: false, userError: { error: "NOT_SIGNED_IN" } };
      }
      const { challenge, allowCredentials } = await ctx.runMutation(
        config.component.authentication.startAuthentication,
        { purpose: ADD_PASSKEY_PURPOSE, userId },
      );
      return { success: true, challenge, allowCredentials, rpId: config.rpId };
    },
  });
}

/**
 * Build the `verifyAddPasskey` mutation of the provider.
 *
 * The mutation does two things in one transaction: it verifies the
 * re-authentication assertion of `startAddPasskey`, and it starts the
 * registration ceremony of the new passkey.
 *
 * The registration challenge that this mutation mints IS the proof of the
 * re-authentication. The provider mints a registration challenge that is
 * bound to a user here and nowhere else: the sign-up flow always gives
 * `userId: null`, because the account does not exist yet. Thus a client
 * that holds such a challenge has completed the assertion above, and
 * `finishAddPasskey` needs no token of its own.
 */
export function verifyAddPasskey(config: UsernamePasskeyConfig) {
  return mutationGeneric({
    args: {
      credentialId: v.bytes(),
      authenticatorData: v.bytes(),
      clientDataJSON: v.bytes(),
      signature: v.bytes(),
    },
    returns: verifyAddPasskeyResult,
    handler: async (ctx, args): Promise<VerifyAddPasskeyResult> => {
      const userId = await getAuthUserId(ctx);
      if (userId === null) {
        return { success: false, userError: { error: "NOT_SIGNED_IN" } };
      }

      const authenticationResult = await ctx.runMutation(
        config.component.authentication.finishAuthentication,
        {
          purpose: ADD_PASSKEY_PURPOSE,
          expectedRpId: config.rpId,
          expectedOrigin: config.origin,
          credentialId: args.credentialId,
          authenticatorData: args.authenticatorData,
          clientDataJSON: args.clientDataJSON,
          signature: args.signature,
        },
      );
      if (!authenticationResult.success) {
        return { success: false, userError: authenticationResult.userError };
      }
      if (authenticationResult.userId !== userId) {
        // Not possible: `startAddPasskey` binds the challenge to the caller,
        // and `finishAuthentication` refuses an assertion from a passkey of
        // a different user. Throwing rolls the burned challenge back.
        throw new Error(
          "Invariant violation: the assertion authenticates a different user than the caller.",
        );
      }

      const { challenge, userHandle, excludeCredentials } =
        await ctx.runMutation(config.component.registration.startRegistration, {
          userId,
        });
      const username = await ctx.runQuery(
        config.usernameComponent.public.getUsername,
        { userId },
      );
      return {
        success: true,
        challenge,
        userHandle,
        excludeCredentials,
        rpId: config.rpId,
        rpName: config.rpName,
        username,
      };
    },
  });
}

/**
 * Build the `finishAddPasskey` mutation of the provider.
 *
 * TODO(nicolas) Add a limit to the number of passkeys of one user. Without
 * a limit, a signed-in user can grow their passkey list without bound, which
 * grows every `allowCredentials` and `excludeCredentials` list with it.
 *
 * The mutation stores the new credential. The registration challenge inside
 * the attestation carries the proof of the re-authentication (see
 * `verifyAddPasskey`), thus the mutation adds no check of its own beyond the
 * session of the caller.
 */
export function finishAddPasskey(config: UsernamePasskeyConfig) {
  return mutationGeneric({
    args: {
      attestationObject: v.bytes(),
      clientDataJSON: v.bytes(),
      transports: v.optional(v.array(v.string())),
    },
    returns: finishAddPasskeyResult,
    handler: async (ctx, args): Promise<FinishAddPasskeyResult> => {
      const userId = await getAuthUserId(ctx);
      if (userId === null) {
        return { success: false, userError: { error: "NOT_SIGNED_IN" } };
      }
      const registrationResult = await ctx.runMutation(
        config.component.registration.finishRegistration,
        {
          expectedRpId: config.rpId,
          expectedOrigin: config.origin,
          verifiedUserId: userId,
          attestationObject: args.attestationObject,
          clientDataJSON: args.clientDataJSON,
          transports: args.transports,
        },
      );
      if (!registrationResult.success) {
        return { success: false, userError: registrationResult.userError };
      }
      return { success: true, passkeyId: registrationResult.passkeyId };
    },
  });
}
