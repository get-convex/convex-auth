import { mutationGeneric } from "convex/server";
import { Infer, v } from "convex/values";
import { getAuthUserId } from "../../core/userId.ts";
import { REMOVE_PASSKEY_PURPOSE } from "../purposes.ts";
import type { UsernamePasskeyConfig } from "../setup.ts";
import {
  credentialDescriptor,
  deletePasskeyUserError,
  finishAuthenticationUserError,
  notSignedInUserError,
} from "../validation.ts";

/**
 * The user-facing error when the user tries to remove their only passkey.
 *
 * With a username and a passkey, a user can never remove their last passkey
 * through this provider: a different passkey must authorize the removal.
 * The component stays permissive and does the deletion; the provider makes
 * the policy. A future option could let the app allow the removal, for
 * example when the app knows that the user has a different way to sign in.
 */
// TODO(nicolas) Give the app a way to allow the removal of the last passkey.
const lastPasskeyUserError = v.object({ error: v.literal("LAST_PASSKEY") });

const startRemovePasskeyResult = v.union(
  v.object({
    success: v.literal(true),
    challenge: v.bytes(),
    allowCredentials: v.array(credentialDescriptor),
    rpId: v.string(),
  }),
  v.object({
    success: v.literal(false),
    userError: v.union(
      notSignedInUserError,
      deletePasskeyUserError,
      lastPasskeyUserError,
    ),
  }),
);

/**
 * The result of `startRemovePasskey`: the data for a `get()` call that
 * authorizes the removal, or a user-facing `userError`.
 */
export type StartRemovePasskeyResult = Infer<typeof startRemovePasskeyResult>;

const finishRemovePasskeyResult = v.union(
  v.object({ success: v.literal(true) }),
  v.object({
    success: v.literal(false),
    userError: v.union(
      notSignedInUserError,
      // `PROTOCOL_ERROR` covers an assertion from the passkey that goes
      // away. See the check in `finishRemovePasskey`.
      finishAuthenticationUserError,
      deletePasskeyUserError,
    ),
  }),
);

/**
 * The result of `finishRemovePasskey`: the removal happened, or a
 * user-facing `userError`.
 */
export type FinishRemovePasskeyResult = Infer<typeof finishRemovePasskeyResult>;

/** Tell if two credential IDs hold the same bytes. */
function sameBytes(a: ArrayBuffer, b: ArrayBuffer): boolean {
  if (a.byteLength !== b.byteLength) {
    return false;
  }
  const left = new Uint8Array(a);
  const right = new Uint8Array(b);
  return left.every((byte, index) => byte === right[index]);
}

/**
 * Build the `startRemovePasskey` mutation of the provider.
 *
 * The removal needs an assertion from a passkey that is not the passkey
 * that goes away, thus the user keeps at least one usable passkey.
 */
export function startRemovePasskey(config: UsernamePasskeyConfig) {
  return mutationGeneric({
    args: { passkeyId: v.string() },
    returns: startRemovePasskeyResult,
    handler: async (ctx, { passkeyId }): Promise<StartRemovePasskeyResult> => {
      const userId = await getAuthUserId(ctx);
      if (userId === null) {
        return { success: false, userError: { error: "NOT_SIGNED_IN" } };
      }

      const passkeys = await ctx.runQuery(
        config.component.registration.listPasskeys,
        { userId },
      );
      const target = passkeys.find(
        (passkey) => passkey.passkeyId === passkeyId,
      );
      if (target === undefined) {
        return { success: false, userError: { error: "PASSKEY_NOT_FOUND" } };
      }
      if (passkeys.length === 1) {
        return { success: false, userError: { error: "LAST_PASSKEY" } };
      }

      const { challenge, allowCredentials } = await ctx.runMutation(
        config.component.authentication.startAuthentication,
        { purpose: REMOVE_PASSKEY_PURPOSE, userId },
      );
      return {
        success: true,
        challenge,
        // The filter helps the user only: the browser then does not offer
        // the passkey that goes away. `finishRemovePasskey` refuses such an
        // assertion again, and that check is the enforcement.
        allowCredentials: allowCredentials.filter(
          (candidate) => !sameBytes(candidate.id, target.credentialId),
        ),
        rpId: config.rpId,
      };
    },
  });
}

/**
 * Build the `finishRemovePasskey` mutation of the provider.
 *
 * The mutation runs every check itself, because the challenge does not
 * carry the target: the purpose must agree, the assertion must come from a
 * different passkey than the target, and the target must belong to the
 * caller.
 *
 * TODO(nicolas) The sessions that the removed passkey started stay valid. A
 * later change could end them with the removal.
 */
export function finishRemovePasskey(config: UsernamePasskeyConfig) {
  return mutationGeneric({
    args: {
      passkeyId: v.string(),
      credentialId: v.bytes(),
      authenticatorData: v.bytes(),
      clientDataJSON: v.bytes(),
      signature: v.bytes(),
    },
    returns: finishRemovePasskeyResult,
    handler: async (ctx, args): Promise<FinishRemovePasskeyResult> => {
      const userId = await getAuthUserId(ctx);
      if (userId === null) {
        return { success: false, userError: { error: "NOT_SIGNED_IN" } };
      }

      const authenticationResult = await ctx.runMutation(
        config.component.authentication.finishAuthentication,
        {
          purpose: REMOVE_PASSKEY_PURPOSE,
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
        // Not possible: `startRemovePasskey` binds the challenge to the
        // caller, and `finishAuthentication` refuses an assertion from a
        // passkey of a different user. Throwing rolls the burned challenge
        // back.
        throw new Error(
          "Invariant violation: the assertion authenticates a different user than the caller.",
        );
      }
      if (authenticationResult.passkeyId === args.passkeyId) {
        // A passkey cannot authorize its own removal: a person who holds one
        // stolen passkey must not be able to erase the passkey of the owner
        // and keep the account. No correct caller reaches this: the browser
        // never gets the target in `allowCredentials`, and an app that sends
        // a `passkeyId` other than the one it started with contradicts its
        // own challenge. Thus the result is a `PROTOCOL_ERROR`, and the
        // message goes to the backend logs only.
        console.warn(
          "Rejected a passkey removal because the assertion comes from the " +
            "passkey that goes away. Check that `finishRemovePasskey` gets " +
            "the same `passkeyId` as the `startRemovePasskey` call that made " +
            "the challenge.",
        );
        return { success: false, userError: { error: "PROTOCOL_ERROR" } };
      }

      const deleteResult = await ctx.runMutation(
        config.component.registration.deletePasskey,
        { userId, passkeyId: args.passkeyId },
      );
      if (!deleteResult.success) {
        return { success: false, userError: deleteResult.userError };
      }
      return { success: true };
    },
  });
}
