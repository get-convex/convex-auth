/**
 * React client for the anonymous provider, exported at
 * `@convex-dev/auth/providers/anonymous/react`.
 *
 * A provider's job on the client is to run its own sign-in flow and hand the
 * resulting {@link TokenBundle} to the core client's `setSession` (see
 * {@link useAuthActions}). This anonymous provider is the simplest case. It
 * has a single mutation that directly returns the `TokenBundle`.
 *
 * It's useful as an example of the bare minimum required of a provider client.
 *
 * @module
 */
"use client";

import { useMutation } from "convex/react";
import { FunctionReference } from "convex/server";
import { useCallback } from "react";
import type { TokenBundle } from "../../lib/types";
import { useAuthActions } from "../../react";

/**
 * The `signInAnonymous` mutation the anonymous provider adds to the app's API.
 */
export type SignInAnonymousMutation = FunctionReference<
  "mutation",
  "public",
  Record<string, never>,
  TokenBundle
>;

/**
 * Client for the anonymous provider: wire its sign-in mutation to the core
 * client.
 *
 * The passed in `signInMutation` mints a session and returns a {@link
 * TokenBundle}; the hook feeds that bundle to `setSession` so the Convex
 * client authenticates. Passing a `TokenBundle` to `setSession` is the general
 * pattern that every auth provider should follow.
 *
 * ```tsx
 * import { useAnonymousAuth } from "@convex-dev/auth/providers/anonymous/react";
 * import { api } from "../convex/_generated/api";
 *
 * function SignIn() {
 *   const { signInAnonymous } = useAnonymousAuth(api.auth.signInAnonymous);
 *   return <button onClick={() => signInAnonymous()}>Sign in anonymously</button>;
 * }
 * ```
 *
 * @param signInMutation The app's `signInAnonymous` mutation reference.
 */
export function useAnonymousAuth(signInMutation: SignInAnonymousMutation) {
  const { setSession } = useAuthActions();
  const runSignIn = useMutation(signInMutation);
  const signInAnonymous = useCallback(async () => {
    await setSession(await runSignIn());
  }, [runSignIn, setSession]);
  return { signInAnonymous };
}
