/**
 * The passkey sign-in flow: its mutation and ceremony sequence, with no
 * React. The hooks of `react.tsx` run it through their ceremony slot.
 * The autofill flow has no entry here: its ceremony
 * runs in the request loop of `usePasskeyAutofill`, which calls the two
 * mutations around it.
 *
 * Internal: the package blocks the
 * `@convex-dev/auth/providers/passkey/flows` path. `react.tsx` re-exports
 * the types an app needs.
 *
 * @module
 */

import type { ConvexReactClient } from "convex/react";
import type { FunctionReference } from "convex/server";
import type { AuthSignInApi } from "../../browser/ambientSignInClient.ts";
import type {
  ClientView,
  SlimTokenBundle,
  TokenBundle,
} from "../../lib/types.ts";
import {
  authenticate,
  register,
  supportsWebAuthn,
  type PasskeyClientError,
  type PasskeyClientFailure,
} from "./client.ts";
import type {
  FinishSignInResult,
  FinishSignUpResult,
  StartAutofillSignInResult,
  StartSignInResult,
} from "./setup.ts";
import type {
  WireAuthenticationResponse,
  WireRegistrationResponse,
} from "./validation.ts";

/**
 * The `startSignIn` mutation the app re-exports from its `setupCore`.
 */
type StartSignInMutation = FunctionReference<
  "mutation",
  "public",
  { username: string },
  StartSignInResult
>;

/**
 * The `startAutofillSignIn` mutation the app re-exports from its
 * `setupCore`.
 */
type StartAutofillSignInMutation = FunctionReference<
  "mutation",
  "public",
  Record<string, never>,
  StartAutofillSignInResult
>;

/**
 * The `finishSignUp` mutation the app re-exports from its `setupCore`.
 *
 * Its return value is the access-only {@link ClientView}, which is what both
 * session models have in common. Hand it to `setSession`, the only supported
 * consumer.
 */
type FinishSignUpMutation = FunctionReference<
  "mutation",
  "public",
  { username: string; response: WireRegistrationResponse },
  ClientView<FinishSignUpResult>
>;

/**
 * The `finishSignIn` mutation the app re-exports from its `setupCore`.
 */
type FinishSignInMutation = FunctionReference<
  "mutation",
  "public",
  { response: WireAuthenticationResponse },
  ClientView<FinishSignInResult>
>;

/** The mutation references the sign-in flows drive. */
export type UsernamePasskeyApi = {
  startSignIn: StartSignInMutation;
  startAutofillSignIn: StartAutofillSignInMutation;
  finishSignIn: FinishSignInMutation;
  finishSignUp: FinishSignUpMutation;
};

/** What the sign-in flows need from the surrounding React tree. */
export type SignInFlowContext = {
  /** The Convex client of the surrounding provider. */
  convex: ConvexReactClient;
  /** The mutation references the app re-exported from its `setupCore`. */
  api: UsernamePasskeyApi;
  /**
   * Runs a mutation that mints a session. The finishing mutations go
   * through this, and not through `convex`, because they must work under
   * both session models (SPA and SSR).
   */
  signInApi: AuthSignInApi;
  /** Stores a minted session. */
  setSession: (session: TokenBundle | SlimTokenBundle) => Promise<void>;
};

/**
 * The result of {@link runSignInOrSignUpFlow}.
 *
 * A success carries a `flow` discriminant: `"signUp"` when the ceremony
 * created a new account, `"signIn"` when it authenticated an existing one.
 */
export type SignInFlowResult =
  | (Extract<ClientView<FinishSignUpResult>, { success: true }> & {
      flow: "signUp";
    })
  | (Extract<ClientView<FinishSignInResult>, { success: true }> & {
      flow: "signIn";
    })
  | Extract<ClientView<FinishSignUpResult>, { success: false }>
  | Extract<ClientView<FinishSignInResult>, { success: false }>
  | Extract<StartSignInResult, { success: false }>
  | PasskeyClientFailure;

/** The errors the autofill sign-in flow reports. */
export type UsernamePasskeyAutofillError =
  | Extract<FinishSignInResult, { success: false }>["userError"]
  | PasskeyClientError;

/**
 * The identifier-first sign-in flow: the start mutation tells whether the
 * username is new, then one ceremony makes a passkey or uses one.
 */
export async function runSignInOrSignUpFlow(
  ctx: SignInFlowContext,
  { username }: { username: string },
): Promise<SignInFlowResult> {
  const { convex, api, signInApi, setSession } = ctx;

  if (!supportsWebAuthn()) {
    return { success: false, userError: { error: "WEBAUTHN_UNSUPPORTED" } };
  }

  const start = await convex.mutation(api.startSignIn, { username });
  if (!start.success) {
    return start;
  }

  if (start.step === "register") {
    // TODO(nicolas) Consider not showing the registration UI immediately,
    // but instead showing a screen that tells the user they have no account
    // and suggest creating one.
    const ceremony = await register(start.options);
    if (!ceremony.success) {
      return ceremony;
    }
    const result = await signInApi.mutation(api.finishSignUp, {
      username,
      response: ceremony.response,
    });
    if (!result.success) {
      return result;
    }
    await setSession(result.tokens);
    return { ...result, flow: "signUp" };
  }

  const ceremony = await authenticate(start.options);
  if (!ceremony.success) {
    return ceremony;
  }
  const result = await signInApi.mutation(api.finishSignIn, {
    response: ceremony.response,
  });
  if (!result.success) {
    return result;
  }
  await setSession(result.tokens);
  return { ...result, flow: "signIn" };
}
