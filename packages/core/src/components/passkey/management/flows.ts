/**
 * The passkey management flows: the mutation and ceremony sequence of each
 * one, with no React. The hooks of `react.tsx` run these through the
 * ceremony slot of `../react.tsx`.
 *
 * Internal: the package blocks the
 * `@convex-dev/auth/providers/passkey/management/flows` path. The hooks
 * re-export the types an app needs.
 *
 * @module
 */

import type { ConvexReactClient } from "convex/react";
import type { FunctionReference } from "convex/server";
import {
  authenticate,
  register,
  type PasskeyClientFailure,
} from "../client.ts";
import type {
  WireAuthenticationResponse,
  WireRegistrationResponse,
} from "../validation.ts";
import type {
  FinishAddPasskeyResult,
  StartAddPasskeyResult,
  VerifyAddPasskeyResult,
} from "./add.ts";
import type {
  FinishRemovePasskeyResult,
  StartRemovePasskeyResult,
} from "./remove.ts";

/** The `startAddPasskey` mutation of the provider. */
type StartAddPasskeyMutation = FunctionReference<
  "mutation",
  "public",
  Record<string, never>,
  StartAddPasskeyResult
>;

/** The `verifyAddPasskey` mutation of the provider. */
type VerifyAddPasskeyMutation = FunctionReference<
  "mutation",
  "public",
  { response: WireAuthenticationResponse },
  VerifyAddPasskeyResult
>;

/** The `finishAddPasskey` mutation of the provider. */
type FinishAddPasskeyMutation = FunctionReference<
  "mutation",
  "public",
  { response: WireRegistrationResponse },
  FinishAddPasskeyResult
>;

/** The `startRemovePasskey` mutation of the provider. */
type StartRemovePasskeyMutation = FunctionReference<
  "mutation",
  "public",
  { passkeyId: string },
  StartRemovePasskeyResult
>;

/** The `finishRemovePasskey` mutation of the provider. */
type FinishRemovePasskeyMutation = FunctionReference<
  "mutation",
  "public",
  { passkeyId: string; response: WireAuthenticationResponse },
  FinishRemovePasskeyResult
>;

/**
 * The function references the add-passkey flow drives.
 * `setupUsernamePasskey` returns them next to the sign-in functions, thus
 * the app module that re-exports the provider carries them all.
 */
export type AddPasskeyApi = {
  startAddPasskey: StartAddPasskeyMutation;
  verifyAddPasskey: VerifyAddPasskeyMutation;
  finishAddPasskey: FinishAddPasskeyMutation;
};

/** The function references the remove-passkey flow drives. */
export type RemovePasskeyApi = {
  startRemovePasskey: StartRemovePasskeyMutation;
  finishRemovePasskey: FinishRemovePasskeyMutation;
};

/**
 * What a management flow needs from the surrounding React tree. Every
 * management function acts on the caller of the session and mints no
 * session of its own, thus they all go straight to the deployment. (The
 * sign-in flows send their finishing mutations through the auth proxy
 * instead; see `flows.ts`.)
 */
export type ManagementFlowContext<Api> = {
  convex: ConvexReactClient;
  api: Api;
};

/** The result of {@link runAddPasskeyFlow}. */
export type AddPasskeyFlowResult =
  | FinishAddPasskeyResult
  | Extract<StartAddPasskeyResult, { success: false }>
  | Extract<VerifyAddPasskeyResult, { success: false }>
  | PasskeyClientFailure;

/** The result of {@link runRemovePasskeyFlow}. */
export type RemovePasskeyFlowResult =
  | FinishRemovePasskeyResult
  | Extract<StartRemovePasskeyResult, { success: false }>
  | PasskeyClientFailure;

/**
 * Adds a passkey to the account of the signed-in user. The flow opens two
 * browser dialogs one after the other: the user first proves the account
 * with a passkey they already hold, then makes the new passkey.
 */
export async function runAddPasskeyFlow(
  ctx: ManagementFlowContext<AddPasskeyApi>,
): Promise<AddPasskeyFlowResult> {
  const { convex, api } = ctx;

  const start = await convex.mutation(api.startAddPasskey, {});
  if (!start.success) {
    return start;
  }
  const assertion = await authenticate(start.options);
  if (!assertion.success) {
    return assertion;
  }
  // The registration challenge that this step mints is the proof of
  // the assertion above, thus the new passkey needs no other token.
  const verified = await convex.mutation(api.verifyAddPasskey, {
    response: assertion.response,
  });
  if (!verified.success) {
    return verified;
  }
  const registration = await register(verified.options);
  if (!registration.success) {
    return registration;
  }
  return await convex.mutation(api.finishAddPasskey, {
    response: registration.response,
  });
}

/**
 * Removes a passkey from the account of the signed-in user. The flow opens
 * one browser dialog: the user must authorize the removal with a DIFFERENT
 * passkey of the account.
 */
export async function runRemovePasskeyFlow(
  ctx: ManagementFlowContext<RemovePasskeyApi>,
  { passkeyId }: { passkeyId: string },
): Promise<RemovePasskeyFlowResult> {
  const { convex, api } = ctx;

  const start = await convex.mutation(api.startRemovePasskey, { passkeyId });
  if (!start.success) {
    return start;
  }
  const assertion = await authenticate(start.options);
  if (!assertion.success) {
    return assertion;
  }
  return await convex.mutation(api.finishRemovePasskey, {
    passkeyId,
    response: assertion.response,
  });
}
