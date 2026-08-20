/**
 * React building blocks for provider-client authors, exported at
 * `@convex-dev/auth/react/providers`. Apps don't need anything here. Provider
 * modules (OAuth, and future auth methods) use these to expose their state as
 * hooks.
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
import { AuthClientContext } from "./client";

export type {
  AmbientSignInClient,
  AmbientSignInContext,
  AuthSignInApi,
} from "../browser/ambientSignInClient";

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
