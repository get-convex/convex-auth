/**
 * React client for the password provider, exported at
 * `@convex-dev/auth/providers/password/react`.
 *
 * A provider's job on the client is to run its own sign-in flow and hand the
 * resulting {@link TokenBundle} to the core client's `setSession` (see {@link
 * useAuthActions}).
 *
 * The password provider has two flows and provides a hook for each:
 *  1. signing in to an existing account ({@link useSignInWithPassword})
 *  2. signing up a new one ({@link useSignUpWithPassword})
 *
 * Each hook returns a function for sending up the credentials and a `pending`
 * value that is flipped to `true` while the credentials are being validated.
 *
 * @module
 */
"use client";

import { useAction } from "convex/react";
import { FunctionReference } from "convex/server";
import { useCallback, useState } from "react";
import { useAuthActions } from "../../react";
import type { SignInResult, SignUpResult } from "./setup";

/** The `(username, password)` pair both flows accept. */
type Credentials = { username: string; password: string };

/**
 * The `signInWithPassword` action the app re-exports from its `setupCore`.
 */
type SignInWithPasswordAction = FunctionReference<
  "action",
  "public",
  Credentials,
  SignInResult
>;

/**
 * The `signUpWithPassword` action the app re-exports from its `setupCore`.
 */
type SignUpWithPasswordAction = FunctionReference<
  "action",
  "public",
  Credentials,
  SignUpResult
>;

/**
 * Client for the password provider's sign-in flow: wire the app's
 * `signInWithPassword` action to the core client.
 *
 * The returned `signIn` runs the action with the given credentials and, on
 * success, establishes an authenticated session with your Convex backend.
 *
 * The `pending` flag returned will let you know if the credentials are
 * currently being validated.
 *
 * After calling `signIn`, check the `success` flag on the return value to see
 * whether the sign-in was successful or if you need to handle an error.
 *
 * ```tsx
 * import { useSignInWithPassword } from "@convex-dev/auth/providers/password/react";
 * import { api } from "../convex/_generated/api";
 *
 * function LogIn() {
 *   const { signIn, pending } = useSignInWithPassword(api.auth.signInWithPassword);
 *   return (
 *     <form
 *       onSubmit={async (e) => {
 *         e.preventDefault();
 *         const result = await signIn({ username, password });
 *         if (!result.success) {
 *           // map result.userError to a message
 *         }
 *       }}
 *     >
 *       <button disabled={pending}>Log in</button>
 *     </form>
 *   );
 * }
 * ```
 *
 * @param signInAction The app's `signInWithPassword` action reference.
 */
export function useSignInWithPassword(signInAction: SignInWithPasswordAction) {
  const { run, pending } = usePasswordFlow(signInAction);
  return { signIn: run, pending };
}

/**
 * Client for the password provider's sign-up flow: wire the app's
 * `signUpWithPassword` action to the core client.
 *
 * The returned `signUp` runs the action with the given credentials and, on
 * success, establishes an authenticated session with your Convex backend.
 *
 * The `pending` flag returned will let you know if the credentials are
 * currently being validated.
 *
 * After calling `signUp`, check the `success` flag on the return value to see
 * whether the sign-up was successful or if you need to handle an error.
 *
 * ```tsx
 * import { useSignUpWithPassword } from "@convex-dev/auth/providers/password/react";
 * import { api } from "../convex/_generated/api";
 *
 * function SignUp() {
 *   const { signUp, pending } = useSignUpWithPassword(api.auth.signUpWithPassword);
 *   // ...same shape as useSignInWithPassword
 * }
 * ```
 *
 * @param signUpAction The app's `signUpWithPassword` action reference.
 */
export function useSignUpWithPassword(signUpAction: SignUpWithPasswordAction) {
  const { run, pending } = usePasswordFlow(signUpAction);
  return { signUp: run, pending };
}

/**
 * Shared internals for sign-in and sign-up: run the action, adopt the session
 * on success, and track in-flight state. The two flows are structurally
 * identical and differ only in the action they call and the name they expose
 * the callback under.
 */
function usePasswordFlow<Result extends SignInResult | SignUpResult>(
  action: FunctionReference<"action", "public", Credentials, Result>,
) {
  const { setSession } = useAuthActions();
  const runAction = useAction(action);
  const [pending, setPending] = useState(false);

  const run = useCallback(
    async (credentials: Credentials) => {
      setPending(true);
      try {
        const result = await runAction(credentials);
        if (result.success) {
          await setSession(result.tokens);
        }
        return result;
      } finally {
        // Reset even if the action throws, so the caller's own catch can
        // surface an unexpected failure without leaving the form stuck.
        setPending(false);
      }
    },
    [runAction, setSession],
  );

  return { run, pending };
}
