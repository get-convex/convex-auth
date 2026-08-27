/**
 * The flow that adds a passkey to a signed-in account.
 *
 * For security purposes, the user must prove again that they
 * hold a pre-existing passkey of the account.
 *
 * ```
 *  Client                             Provider
 *    │                                   │
 *    │  startAddPasskey()                │
 *    ├──────────────────────────────────▶│  start the re-authentication
 *    │◀──────────────────────────────────┤
 *    │                                   │
 *    ├─▶ navigator.credentials.get()     │
 *    │                                   │
 *    │  verifyAddPasskey(assertion)      │
 *    ├──────────────────────────────────▶│  verify it, start the registration
 *    │◀──────────────────────────────────┤
 *    │                                   │
 *    ├─▶ navigator.credentials.create()  │
 *    │                                   │
 *    │  finishAddPasskey(attestation)    │
 *    ├──────────────────────────────────▶│  store the new passkey
 *    │◀──────────────────────────────────┤
 *    │                                   │
 * ```
 *
 * @module
 */
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
    // `PROTOCOL_ERROR` also covers an assertion that authenticates a
    // different user than the caller. See the check in `verifyAddPasskey`.
    userError: v.union(notSignedInUserError, finishAuthenticationUserError),
  }),
);

export type VerifyAddPasskeyResult = Infer<typeof verifyAddPasskeyResult>;

const finishAddPasskeyResult = v.union(
  v.object({ success: v.literal(true), passkeyId: v.string() }),
  v.object({
    success: v.literal(false),
    userError: v.union(notSignedInUserError, finishRegistrationUserError),
  }),
);

export type FinishAddPasskeyResult = Infer<typeof finishAddPasskeyResult>;

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
      if (allowCredentials.length === 0) {
        // TODO: When auth flows are more composable, we should just ask the user to reauthenticate another way.
        throw new Error(
          "The signed-in user has no passkey. They can’t add a new passkey, because we can’t ask them to reauthenticate.",
        );
      }
      return { success: true, challenge, allowCredentials, rpId: config.rpId };
    },
  });
}

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
        // The identity of the caller changed between `startAddPasskey` and
        // this call: the challenge stays bound to the user who started the
        // ceremony, and that user is no longer the caller. A sign-out and a
        // new sign-in, or a race with a sign-in in a different tab, both do
        // this. The result is a `PROTOCOL_ERROR`, which keeps the challenge
        // burned and thus prevents a replay of the assertion.
        console.warn(
          "Rejected an addition of a passkey because the assertion " +
            "authenticates a different user than the caller. The caller " +
            "signed in as a different user after the `startAddPasskey` call.",
        );
        return { success: false, userError: { error: "PROTOCOL_ERROR" } };
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

export function finishAddPasskey(config: UsernamePasskeyConfig) {
  return mutationGeneric({
    args: {
      attestationObject: v.bytes(),
      clientDataJSON: v.bytes(),
      transports: v.optional(v.array(v.string())),
    },
    returns: finishAddPasskeyResult,
    handler: async (ctx, args): Promise<FinishAddPasskeyResult> => {
      // TODO(nicolas) Add a limit to how many paskseys can be registered
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
        // A `PROTOCOL_ERROR` here also covers a registration ceremony that
        // belongs to a different user than the caller, which happens when the
        // caller signs in as a different user after the `verifyAddPasskey`
        // call. `finishRegistration` compares the owner of the ceremony with
        // `verifiedUserId`, thus this call needs no check of its own. See the
        // same case in `verifyAddPasskey`.
        return { success: false, userError: registrationResult.userError };
      }
      return { success: true, passkeyId: registrationResult.passkeyId };
    },
  });
}
