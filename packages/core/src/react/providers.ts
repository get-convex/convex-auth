/**
 * React building blocks for provider-client authors, exported at
 * `@convex-dev/auth/react/providers`. Apps don't need anything here. Provider
 * modules (OAuth, and future auth methods) use these to expose their state as
 * hooks.
 *
 * A sign-in hook hands every result its sign-in function returns to
 * {@link useAdoptSignInResult}, which adopts the session of a `complete` one
 * and holds an `incomplete` one for the app's `usePendingSignIn`.
 *
 * An ambient sign-in publishes its actions and status from its
 * {@link AmbientSignInClient} (passed to `ConvexAuthProvider`'s
 * `ambientSignIns` prop); its hooks read them back with
 * {@link useAmbientSignInValue}.
 *
 * @module
 */
"use client";

import { useCallback, useContext, useSyncExternalStore } from "react";
import {
  AuthClientContext,
  usePendingSignInContext,
  type AdoptableSignInResult,
} from "./client.tsx";

export type { AdoptableSignInResult };

export type {
  AmbientSignInClient,
  AmbientSignInContext,
  AuthSignInApi,
} from "../browser/ambientSignInClient.ts";

/**
 * Subscribe to a value published by the ambient sign-in registered as `id`
 * (the same scope its setup writes through). Returns `undefined` when nothing
 * is registered at `key`, typically meaning the sign-in wasn't passed to
 * `ConvexAuthProvider`'s `ambientSignIns` prop, which provider hooks should
 * surface as an error.
 */
export function useAmbientSignInValue<T>(
  id: string,
  key: string,
): T | undefined {
  const client = useContext(AuthClientContext);
  if (client === undefined) {
    throw new Error(
      "useAmbientSignInValue must be used within a <ConvexAuthProvider>.",
    );
  }
  const subscribe = useCallback(
    (listener: () => void) =>
      client.ambientSignInValues(id).subscribe(key, listener),
    [client, id, key],
  );
  const getSnapshot = useCallback(
    // The values are already published during SSR, so the server snapshot is
    // the same read.
    () => client.ambientSignInValues(id).get<T>(key),
    [client, id, key],
  );
  return useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
}

/**
 * The function a provider's sign-in hook hands its sign-in function's result
 * to, in place of calling `setSession` itself.
 *
 * A `complete` result's session is adopted. An `incomplete` one becomes the
 * pending sign-in the app reads with `usePendingSignIn`, so the app renders
 * the step its requirements name. `SIGN_IN_EXPIRED` marks the pending
 * sign-in expired. Other errors are left to the hook's caller.
 */
export function useAdoptSignInResult(): (
  result: AdoptableSignInResult,
) => Promise<void> {
  return usePendingSignInContext().adopt;
}
