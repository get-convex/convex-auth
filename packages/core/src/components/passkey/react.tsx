/**
 * React client for the passkey provider, exported at
 * `@convex-dev/auth/providers/passkey/react`.
 *
 * {@link useUsernamePasskeySignIn} is the batteries-included hook for the
 * username + passkey login form. It drives the browser-side WebAuthn
 * ceremonies (through the internal client module built on
 * `@simplewebauthn/browser`) against the mutations of a passkey recipe,
 * and it handles both the identifier-first modal flow and passkey autofill
 * (conditional mediation), where the user selects an account directly in
 * the autocompletion list.
 *
 * @module
 */
"use client";

import { useConvex } from "convex/react";
import { useCallback, useMemo, useRef } from "react";
import { useAuthActions, useAuthSignInApi } from "../../react/index.tsx";
import {
  runSignInOrSignUpFlow,
  type UsernamePasskeyApi,
  type UsernamePasskeyAutofillError,
  type SignInFlowResult,
} from "./flows.ts";
import {
  usePasskeyAutofill,
  usePasskeyCeremonySlot,
  type AlreadyPendingFailure,
} from "./react_impl.tsx";

// Apps read the WebAuthn JSON types and the browser-side failure shapes
// from here, so they never depend on `@simplewebauthn/*` directly.
export type {
  AuthenticationResponseJSON,
  PasskeyClientError,
  PasskeyClientFailure,
  PublicKeyCredentialCreationOptionsJSON,
  PublicKeyCredentialRequestOptionsJSON,
  RegistrationResponseJSON,
  WireAuthenticationResponse,
  WireCreationOptions,
  WireRegistrationResponse,
  WireRequestOptions,
} from "./client.ts";
export type {
  UsernamePasskeyApi,
  UsernamePasskeyAutofillError,
} from "./flows.ts";
export type {
  AlreadyPendingFailure,
  PasskeyAutofillStatus,
} from "./react_impl.tsx";

/**
 * The result of the `signIn` callback from {@link useUsernamePasskeySignIn}.
 *
 * A success carries a `flow` discriminant: `"signUp"` when the ceremony
 * created a new account, `"signIn"` when it authenticated an existing one.
 * `ALREADY_PENDING` comes back when a `signIn` call runs while the
 * previous one still does.
 */
export type UsernamePasskeySignInResult =
  SignInFlowResult | AlreadyPendingFailure;

/**
 * Client for the log in page in the “username + passkey” auth flow.
 *
 * This client handles both:
 * - Manually logging in by providing an identifier (e.g. username)
 *   then registering a new passkey or logging in
 * - Passkey autofill (conditional mediation) where the user selects an account
 *   directly in the autocompletion list.
 *
 * ```tsx
 * import { useUsernamePasskeySignIn } from "@convex-dev/auth/providers/passkey/react";
 * import { api } from "../convex/_generated/api";
 *
 * function LogIn() {
 *   const { signIn, pending, autofill } = useUsernamePasskeySignIn({
 *     startSignIn: api.auth.startSignIn,
 *     startAutofillSignIn: api.auth.startAutofillSignIn,
 *     finishSignIn: api.auth.finishSignIn,
 *     finishSignUp: api.auth.finishSignUp,
 *   });
 *   return (
 *     <form
 *       onSubmit={async (e) => {
 *         e.preventDefault();
 *         const result = await signIn({ username });
 *         if (!result.success) {
 *           // map result.userError to a message
 *         }
 *       }}
 *     >
 *       <input autoComplete="username webauthn" ... />
 *       <button disabled={pending}>Continue</button>
 *     </form>
 *   );
 * }
 * ```
 *
 * @param usernamePasskeyApi The app's re-exported passkey mutation references.
 */
export function useUsernamePasskeySignIn(
  usernamePasskeyApi: UsernamePasskeyApi,
) {
  const { setSession } = useAuthActions();

  // Using useAuthSignInApi for mutations that return a session to support SSR
  const signInApi = useAuthSignInApi();
  const convex = useConvex();

  // Store the flow context in a ref: Convex function references are not
  // referentially stable across renders. We only need to access them in
  // event callbacks, so using a ref ensures we always use the latest
  // function reference from the callback.
  const ctxRef = useRef({
    convex,
    api: usernamePasskeyApi,
    signInApi,
    setSession,
  });
  ctxRef.current = { convex, api: usernamePasskeyApi, signInApi, setSession };

  const autofill = usePasskeyAutofill<UsernamePasskeyAutofillError>({
    start: async () => {
      const { convex, api } = ctxRef.current;
      const { options } = await convex.mutation(api.startAutofillSignIn, {});
      return options;
    },
    onAssertion: async (response) => {
      const { api, signInApi, setSession } = ctxRef.current;
      const result = await signInApi.mutation(api.finishSignIn, { response });
      if (!result.success) {
        return result;
      }

      // There’s a small race with the modal flow here. When the user resolves the
      // autofill assertion just before the modal flow pauses the request,
      // and the modal ceremony also completes, `setSession` runs twice and
      // the last write wins. Both sessions are valid, so this is harmless.

      await setSession(result.tokens);
      return { success: true };
    },
  });

  const { run, pending } = usePasskeyCeremonySlot({ autofill });

  const signIn = useCallback(
    ({
      username,
    }: {
      username: string;
    }): Promise<UsernamePasskeySignInResult> =>
      run(() => runSignInOrSignUpFlow(ctxRef.current, { username })),
    [run],
  );

  return useMemo(
    () => ({
      /**
       * Runs the identifier-first passkey flow for the given username.
       *
       * Returns an object with a `success` boolean flag.
       *
       * If it is `true` the sign-in (or the account creation) was
       * successful and the client will establish an authenticated session
       * with the Convex backend server. The `flow` field tells which one
       * it was: `"signUp"` created a new account, `"signIn"` authenticated
       * an existing one.
       *
       * If it is `false` the returned object will have a `userError` field
       * with additional details about why sign-in failed.
       */
      signIn,
      /** `true` while a `signIn` attempt is running. */
      pending,
      /**
       * The state of the autofill flow:
       *
       * - `available`: whether the browser can offer passkeys in the
       *   autocompletion list; `null` while the detection runs.
       * - `status`: the state of the request; see
       *   {@link PasskeyAutofillStatus}.
       * - `lastError`: the most recent failure, for display or logging.
       */
      autofill: {
        available: autofill.available,
        status: autofill.status,
        lastError: autofill.lastError,
      },
    }),
    [signIn, pending, autofill],
  );
}
