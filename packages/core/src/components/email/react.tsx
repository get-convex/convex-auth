/**
 * React client for the `EmailPassword` provider, exported at
 * `@convex-dev/auth/providers/email-password/react`.
 *
 * @module
 */
"use client";

import { FunctionReference } from "convex/server";
import { useCallback, useRef, useState } from "react";
import type { ClientView } from "../../lib/types.ts";
import { useAuthActions, useAuthSignInApi } from "../../react/index.tsx";
import type { SignInResult as SignInMutationResult } from "./setup.ts";

//------------------------------------------------------------------------------
// Result types
//------------------------------------------------------------------------------

/**
 * The mutation threw rather than resolving to a `userError`. The thrown value
 * is preserved on `cause`.
 */
type OtherError = { error: "OTHER_ERROR"; cause: unknown };

type SignInUnexpectedFailure = { status: "error"; userError: OtherError };

type SignInMutation = FunctionReference<
  "mutation",
  "public",
  { email: string; password: string },
  ClientView<SignInMutationResult>
>;

/** The result of the `signIn` callback from {@link useSignInWithEmailPassword}. */
export type SignInResult =
  ClientView<SignInMutationResult> | SignInUnexpectedFailure;

//------------------------------------------------------------------------------
// Shared helpers
//------------------------------------------------------------------------------

/**
 * Track the in-flight state of async calls.
 */
function usePending() {
  const [pending, setPending] = useState(false);

  // We count the number of pending calls out of safety.
  // Normally apps shouldn’t start concurrent flows (e.g. they should disable
  // form submission when a current submission is ongoing), this is just a layer
  // of extra safey in case they don’t do it correctly.
  const inFlight = useRef(0);

  const track = useCallback(async <T,>(work: () => Promise<T>): Promise<T> => {
    inFlight.current++;
    setPending(true);
    try {
      return await work();
    } finally {
      if (--inFlight.current === 0) setPending(false);
    }
  }, []);
  return { pending, track };
}

const foldSignInError = (cause: unknown): SignInUnexpectedFailure => ({
  status: "error",
  userError: { error: "OTHER_ERROR", cause },
});

//------------------------------------------------------------------------------
// Sign-in
//------------------------------------------------------------------------------

/**
 * Client for the sign-in flow: run the backend's `signIn` mutation and, on
 * success, establish an authenticated session.
 *
 * ```tsx
 * function LogIn() {
 *   const { signIn, pending } = useSignInWithEmailPassword(api.auth.signIn);
 *   const [email, setEmail] = useState("");
 *   const [password, setPassword] = useState("");
 *   const [error, setError] = useState<string | null>(null);
 *
 *   return (
 *     <form
 *       onSubmit={async (e) => {
 *         e.preventDefault();
 *         const result = await signIn({ email, password });
 *         // map result.userError (INVALID_CREDENTIALS, …) to a message
 *         setError(result.status === "error" ? result.userError.error : null);
 *       }}
 *     >
 *       <label>
 *         Email
 *         <input
 *           type="email"
 *           autoComplete="username"
 *           required
 *           value={email}
 *           onChange={(e) => setEmail(e.target.value)}
 *           disabled={pending}
 *         />
 *       </label>
 *       <label>
 *         Password
 *         <input
 *           type="password"
 *           autoComplete="current-password"
 *           required
 *           value={password}
 *           onChange={(e) => setPassword(e.target.value)}
 *           disabled={pending}
 *         />
 *       </label>
 *       {error !== null && <p role="alert">{error}</p>}
 *       <button type="submit" disabled={pending}>
 *         Log in
 *       </button>
 *     </form>
 *   );
 * }
 * ```
 *
 * @param signInMutation The app's `signIn` mutation reference.
 */
export function useSignInWithEmailPassword(signInMutation: SignInMutation) {
  const { setSession } = useAuthActions();
  const signInApi = useAuthSignInApi();
  const { pending, track } = usePending();

  const signIn = useCallback(
    async (credentials: {
      email: string;
      password: string;
    }): Promise<SignInResult> =>
      track(async () => {
        try {
          const result = await signInApi.mutation(signInMutation, credentials);
          if (result.status === "complete") {
            await setSession(result.tokens);
          }
          return result;
        } catch (cause) {
          return foldSignInError(cause);
        }
      }),
    [signInApi, signInMutation, setSession, track],
  );

  return { signIn, pending };
}
