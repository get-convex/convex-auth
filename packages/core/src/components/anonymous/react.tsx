/**
 * React client for the anonymous provider, exported at
 * `@convex-dev/auth/providers/anonymous/react`.
 *
 * A provider's job on the client is to run its own sign-in flow and hand the
 * resulting {@link TokenBundle} to the core client's `setSession` (see
 * {@link useAuthActions}). This anonymous provider is the simplest case. It
 * has a single mutation that directly returns the `TokenBundle`.
 *
 * It's useful as an example of the bare minimum a provider needs on the
 * client: one hook, and no registration with the auth client at all.
 *
 * @module
 */
"use client";

import { FunctionReference } from "convex/server";
import { useCallback } from "react";
import type { ClientView, SignInSuccess } from "../../lib/types.ts";
import { useAuthActions, useAuthSignInApi } from "../../react/index.tsx";

/**
 * The `signInAnonymous` mutation the anonymous provider adds to the app's API.
 *
 * Its bundle is the access-only {@link ClientView}, which is what both session
 * models have in common. Hand it to `setSession`, the only supported consumer.
 */
export type SignInAnonymousMutation = FunctionReference<
  "mutation",
  "public",
  Record<string, never>,
  ClientView<SignInSuccess>
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
 * When the `TokenBundle` is passed to `setSession`, that kicks off the
 * internal Convex auth machinery that authenticates the client with the
 * configured backend and re-renders components in an authenticated state.
 * Content within `<Authenticated>` helper components will render as will other
 * components that build on the authenticated state returned by
 * `useConvexAuthActions`.
 *
 * @param signInMutation The app's `signInAnonymous` mutation reference.
 */
export function useAnonymousAuth(signInMutation: SignInAnonymousMutation) {
  const { setSession } = useAuthActions();
  // Running through the signInApi rather than `useMutation` is what lets this one
  // hook serve both session models. See {@link AuthSignInApi}.
  const signInApi = useAuthSignInApi();
  const signInAnonymous = useCallback(async () => {
    const result = await signInApi.mutation(signInMutation, {});
    await setSession(result.tokens);
  }, [signInApi, signInMutation, setSession]);
  return { signInAnonymous };
}
