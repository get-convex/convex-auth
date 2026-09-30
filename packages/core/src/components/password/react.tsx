/**
 * React client for the password provider, exported at
 * `@convex-dev/auth/providers/password/react`.
 *
 * A provider's job on the client is to run its own sign-in flow and hand the
 * result to the core client, which adopts the session of a `complete` one and
 * holds an `incomplete` one as the pending sign-in.
 *
 * The password provider has two flows and provides a hook for each:
 *  1. signing in to an existing account ({@link useSignInWithPassword})
 *  2. signing up a new one ({@link useSignUpWithPassword})
 *
 * Each hook returns a function for sending up the credentials and a `pending`
 * value that is flipped to `true` while the credentials are being validated.
 *
 * A sign-in the backend holds for a TOTP code comes back `incomplete`, and
 * becomes the pending sign-in `usePendingSignIn` (from
 * `@convex-dev/auth/react`) reports. The app then asks for the code with the
 * TOTP recipe's `useTotpSignInStep`, which is not specific to passwords, so
 * it does not live here.
 *
 * @module
 */
"use client";

import { FunctionReference } from "convex/server";
import { useCallback, useState } from "react";
import type { ClientView } from "../../lib/types.ts";
import {
  useAuthSignInApi,
  usePendingSignInContext,
} from "../../react/client.tsx";
import type { SignInResult, SignUpResult } from "./setup.ts";

/** The `(username, password)` pair both flows accept. */
export type Credentials = { username: string; password: string };

/**
 * The `signInWithPassword` mutation the app re-exports from its `setupCore`.
 *
 * `Result` is the mutation's own result type, which the hooks read off the
 * reference so the app sees the `incomplete` arm only when its backend recipe
 * was set up with the `totp` option. What the hooks return is the access-only
 * {@link ClientView} of it, which is what both session models have in common.
 * Hand its tokens to `setSession`, the only supported consumer.
 */
type SignInWithPasswordMutation<Result extends SignInResult> =
  FunctionReference<"mutation", "public", Credentials, Result>;

/**
 * The `signUpWithPassword` mutation the app re-exports from its `setupCore`.
 */
type SignUpWithPasswordMutation = FunctionReference<
  "mutation",
  "public",
  Credentials,
  SignUpResult
>;

/**
 * A failure the client produces that the server never returns: the mutation
 * threw (a network blip, a bug, an unexpected server error) rather than
 * resolving to a `userError`. The flow hooks fold that into the result as
 * `OTHER_ERROR` so callers handle *every* failure through the one `userError`
 * switch and never need their own `try`/`catch`. The thrown value is preserved
 * on `cause` for callers that want to inspect or log it.
 */
type UnexpectedFailure = {
  status: "error";
  userError: { error: "OTHER_ERROR"; cause: unknown };
};

/**
 * The result of the `signIn` callback from {@link useSignInWithPassword}.
 *
 * `Result` is the backend mutation's result type; the default covers a
 * recipe with the `totp` option.
 */
export type SignInWithPasswordResult<
  Result extends SignInResult = SignInResult,
> = ClientView<Result> | UnexpectedFailure;

/** The result of the `signUp` callback from {@link useSignUpWithPassword}. */
export type SignUpWithPasswordResult =
  ClientView<SignUpResult> | UnexpectedFailure;

/**
 * Client for the password provider's sign-in flow: wire the backend's
 * `signInWithPassword` mutation to the core client.
 *
 * The returned `signIn` runs the mutation with the given credentials and, on
 * success, establishes an authenticated session with your Convex backend.
 *
 * The `pending` flag returned will let you know if the credentials are
 * currently being validated.
 *
 * After calling `signIn`, check the `status` field on the return value to see
 * whether the sign-in was successful, whether it waits on a TOTP code, or if
 * you need to handle an error.
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
 *         if (result.status === "incomplete") {
 *           // usePendingSignIn now reports the sign-in; render the step
 *           // its requirements name (useTotpSignInStep for "totp")
 *         } else if (result.status === "error") {
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
 * @param signInMutation The app's `signInWithPassword` mutation reference.
 */
export function useSignInWithPassword<Result extends SignInResult>(
  signInMutation: SignInWithPasswordMutation<Result>,
) {
  const { run, pending } = usePasswordFlow(signInMutation);
  return {
    /**
     * Passes up the given crendentials to perform a username/password sign in.
     *
     * Returns an object with a `status` field.
     *
     * If it is `"complete"` the sign-in was successful and the client will
     * establish an authenticated session with the Convex backend server.
     *
     * If it is `"incomplete"` the password was right and the user owes a
     * TOTP code: `usePendingSignIn` now reports the held sign-in, and
     * `useTotpSignInStep` finishes it with a code. This happens when the
     * backend recipe was set up with the `totp` option, for users who have
     * enrolled.
     *
     * If it is `"error"` the returned object will have a `userError` field with
     * additional details about why sign-in failed.
     */
    signIn: run,
    /** `true` if the sign-in attempt is being validated. */
    pending,
  };
}

/**
 * Client for the password provider's sign-up flow: wire the backend's
 * `signUpWithPassword` mutation to the core client.
 *
 * The returned `signUp` runs the mutation with the given credentials and, on
 * success, establishes an authenticated session with your Convex backend.
 *
 * The `pending` flag returned will let you know if the credentials are
 * currently being validated.
 *
 * After calling `signUp`, check the `status` field on the return value to see
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
 * @param signUpMutation The backend's `signUpWithPassword` mutation reference.
 */
export function useSignUpWithPassword(
  signUpMutation: SignUpWithPasswordMutation,
) {
  const { run, pending } = usePasswordFlow(signUpMutation);
  return {
    /**
     * Passes up the given crendentials to perform a username/password sign up.
     *
     * Returns an object with a `status` field.
     *
     * If it is `"complete"` the sign-up was successful and the client will
     * establish an authenticated session with the Convex backend server.
     *
     * If it is `"error"` the returned object will have a `userError` field with
     * additional details about why sign-up failed.
     */
    signUp: run,
    /** `true` if the sign-up attempt is being validated. */
    pending,
  };
}

/**
 * Shared internals of the flows: run the mutation, adopt the session on
 * success, and track in-flight state. The flows are structurally identical
 * and differ only in the mutation they call, its result, and the name they
 * expose the callback under.
 */
function usePasswordFlow<Result extends SignInResult | SignUpResult>(
  mutation: FunctionReference<"mutation", "public", Credentials, Result>,
) {
  const { adopt } = usePendingSignInContext();
  // Running through the signInApi rather than `useAction` is what lets these hooks
  // serve both session models. See {@link useAuthSignInApi}.
  const signInApi = useAuthSignInApi();
  const [pending, setPending] = useState(false);

  const run = useCallback(
    async (
      credentials: Credentials,
    ): Promise<ClientView<Result> | UnexpectedFailure> => {
      setPending(true);
      try {
        // Under SSR the proxy has already slimmed the bundle, so what arrives
        // is the client view whatever the reference's type says.
        const result = (await signInApi.mutation(
          mutation,
          credentials,
        )) as ClientView<Result>;
        // An incomplete sign-in minted nothing: it becomes the pending
        // sign-in, the caller shows the next step, and the result passes
        // through as it is.
        await adopt(result);
        return result;
      } catch (cause) {
        // The mutation threw instead of resolving to a `userError`. Fold it into
        // the same discriminated result as `OTHER_ERROR`, preserving the thrown
        // value on `cause`, so the caller handles it alongside every other
        // failure and can still inspect or log the original error if it wants.
        return { status: "error", userError: { error: "OTHER_ERROR", cause } };
      } finally {
        // Reset even when the mutation throws.
        setPending(false);
      }
    },
    [signInApi, mutation, adopt],
  );

  return { run, pending };
}
