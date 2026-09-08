/**
 * React client for the passkey provider, exported at
 * `@convex-dev/auth/providers/passkey/react`.
 *
 * {@link usePasskey} is the batteries-included hook for the username +
 * passkey login form. It drives the browser-side WebAuthn ceremonies (see
 * `@convex-dev/auth/providers/passkey/client`) against the mutations of a
 * passkey recipe, and it handles both the identifier-first modal flow and
 * passkey autofill (conditional mediation), where the user selects an
 * account directly in the autocompletion list.
 *
 * @module
 */
"use client";

import { useConvex } from "convex/react";
import { useCallback, useMemo, useRef } from "react";
import { useAuthActions, useAuthSignInApi } from "../../react/index.tsx";
import {
  runSignInOrSignUpFlow,
  type PasskeyApi,
  type PasskeyAutofillError,
  type SignInFlowResult,
} from "./flows.ts";
import {
  usePasskeyAutofill,
  usePasskeyCeremonySlot,
  type AlreadyPendingFailure,
} from "./react_impl.tsx";

export type { PasskeyClientError } from "./client.ts";
export type { PasskeyApi, PasskeyAutofillError } from "./flows.ts";
export type {
  AlreadyPendingFailure,
  PasskeyAutofillStatus,
} from "./react_impl.tsx";

/**
 * The result of the `signIn` callback from {@link usePasskey}.
 *
 * A success carries a `flow` discriminant: `"signUp"` when the ceremony
 * created a new account, `"signIn"` when it authenticated an existing one.
 * `ALREADY_PENDING` comes back when a `signIn` call runs while the
 * previous one still does.
 */
export type PasskeySignInResult = SignInFlowResult | AlreadyPendingFailure;

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
 * import { usePasskey } from "@convex-dev/auth/providers/passkey/react";
 * import { api } from "../convex/_generated/api";
 *
 * function LogIn() {
 *   const { signIn, pending, autofill } = usePasskey({
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
 * @param passkeyApi The app's re-exported passkey mutation references.
 */
export function usePasskey(passkeyApi: PasskeyApi) {
  const { setSession } = useAuthActions();

  // Using useAuthSignInApi for mutations that return a session to support SSR
  const signInApi = useAuthSignInApi();
  const convex = useConvex();

  // Store the flow context in a ref: Convex function references are not
  // referentially stable across renders. We only need to access them in
  // event callbacks, so using a ref ensures we always use the latest
  // function reference from the callback.
  const ctxRef = useRef({ convex, api: passkeyApi, signInApi, setSession });
  ctxRef.current = { convex, api: passkeyApi, signInApi, setSession };

  const autofill = usePasskeyAutofill<PasskeyAutofillError>({
    start: () => {
      const { convex, api } = ctxRef.current;
      return convex.mutation(api.startAutofillSignIn, {});
    },
    onAssertion: async (assertion) => {
      const { api, signInApi, setSession } = ctxRef.current;
      const result = await signInApi.mutation(api.finishSignIn, assertion);
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
    ({ username }: { username: string }): Promise<PasskeySignInResult> =>
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
