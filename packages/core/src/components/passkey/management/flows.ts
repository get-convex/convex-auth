/**
 * The passkey management flows: adding and removing a passkey.
 *
 * @module
 */

import type { FunctionReference } from "convex/server";
import type { AuthClient } from "../../../browser/sessionManager.ts";
import {
  authenticate,
  register,
  supportsWebAuthn,
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

type StartAddPasskeyMutation = FunctionReference<
  "mutation",
  "public",
  Record<string, never>,
  StartAddPasskeyResult
>;

type VerifyAddPasskeyMutation = FunctionReference<
  "mutation",
  "public",
  { response: WireAuthenticationResponse },
  VerifyAddPasskeyResult
>;

type FinishAddPasskeyMutation = FunctionReference<
  "mutation",
  "public",
  { response: WireRegistrationResponse },
  FinishAddPasskeyResult
>;

type StartRemovePasskeyMutation = FunctionReference<
  "mutation",
  "public",
  { passkeyId: string },
  StartRemovePasskeyResult
>;

type FinishRemovePasskeyMutation = FunctionReference<
  "mutation",
  "public",
  { passkeyId: string; response: WireAuthenticationResponse },
  FinishRemovePasskeyResult
>;

export type AddPasskeyApi = {
  startAddPasskey: StartAddPasskeyMutation;
  verifyAddPasskey: VerifyAddPasskeyMutation;
  finishAddPasskey: FinishAddPasskeyMutation;
};

export type RemovePasskeyApi = {
  startRemovePasskey: StartRemovePasskeyMutation;
  finishRemovePasskey: FinishRemovePasskeyMutation;
};

export type ManagementFlowContext<Api> = {
  /** The auth client, whose Convex client runs the mutations. */
  auth: AuthClient;
  api: Api;
};

export type AddPasskeyFlowResult =
  | FinishAddPasskeyResult
  | Extract<StartAddPasskeyResult, { success: false }>
  | Extract<VerifyAddPasskeyResult, { success: false }>
  | PasskeyClientFailure;

export type RemovePasskeyFlowResult =
  | FinishRemovePasskeyResult
  | Extract<StartRemovePasskeyResult, { success: false }>
  | PasskeyClientFailure;

/**
 * Adds a passkey to the account of the signed-in user.
 *
 * First asks the user to authenticate with an existing passkey to prove
 * their identity, then registers a new passkey.
 */
export async function runAddPasskeyFlow(
  ctx: ManagementFlowContext<AddPasskeyApi>,
): Promise<AddPasskeyFlowResult> {
  const { auth, api } = ctx;

  if (!supportsWebAuthn()) {
    return { success: false, userError: { error: "WEBAUTHN_UNSUPPORTED" } };
  }

  const start = await auth.convex.mutation(api.startAddPasskey, {});
  if (!start.success) {
    return start;
  }
  const assertion = await authenticate(start.options);
  if (!assertion.success) {
    return assertion;
  }
  const verified = await auth.convex.mutation(api.verifyAddPasskey, {
    response: assertion.response,
  });
  if (!verified.success) {
    return verified;
  }
  const registration = await register(verified.options);
  if (!registration.success) {
    return registration;
  }
  return await auth.convex.mutation(api.finishAddPasskey, {
    response: registration.response,
  });
}

/**
 * Removes a passkey from the account of the signed-in user.
 *
 * The user must authenticate with another passkey first.
 */
export async function runRemovePasskeyFlow(
  ctx: ManagementFlowContext<RemovePasskeyApi>,
  { passkeyId }: { passkeyId: string },
): Promise<RemovePasskeyFlowResult> {
  const { auth, api } = ctx;

  if (!supportsWebAuthn()) {
    return { success: false, userError: { error: "WEBAUTHN_UNSUPPORTED" } };
  }

  const start = await auth.convex.mutation(api.startRemovePasskey, {
    passkeyId,
  });
  if (!start.success) {
    return start;
  }
  const assertion = await authenticate(start.options);
  if (!assertion.success) {
    return assertion;
  }
  return await auth.convex.mutation(api.finishRemovePasskey, {
    passkeyId,
    response: assertion.response,
  });
}
