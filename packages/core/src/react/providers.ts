/**
 * React building blocks for provider-client authors, exported at
 * `@convex-dev/auth/react/providers`. Apps don't need anything here. Provider
 * modules (OAuth, and future auth methods) use these to expose their state as
 * hooks.
 *
 * A provider client registers its actions and flow state in the auth client's
 * keyed store from its {@link AuthProviderClientSetup} (passed to
 * `ConvexAuthProvider`'s `providerClients` prop); its hooks read them back
 * with {@link useAuthClientValue}.
 *
 * @module
 */
"use client";

import { useCallback, useContext, useSyncExternalStore } from "react";
import { scopedKey } from "../browser/keyedStore";
import { AuthClientContext } from "./client";

export { KeyedStore } from "../browser/keyedStore";
export type {
  AuthProviderClientContext,
  AuthProviderClientSetup,
  AuthSignInApi,
} from "../browser/providerSetup";

/**
 * Subscribe to a value in the auth client's keyed store, under the provider
 * client registered as `id` (the same scope its setup writes through).
 * Returns `undefined` when nothing is registered at `key`, typically meaning
 * the provider's setup wasn't passed to `ConvexAuthProvider`'s
 * `providerClients` prop, which provider hooks should surface as an error.
 */
export function useAuthClientValue<T>(id: string, key: string): T | undefined {
  const client = useContext(AuthClientContext);
  if (client === undefined) {
    throw new Error(
      "useAuthClientValue must be used within a <ConvexAuthProvider>.",
    );
  }
  const fullKey = scopedKey(id, key);
  const subscribe = useCallback(
    (listener: () => void) => client.store.subscribe(fullKey, listener),
    [client, fullKey],
  );
  const getSnapshot = useCallback(
    // The store is already populated during SSR, so the server snapshot is
    // the same read.
    () => client.store.get<T>(fullKey),
    [client, fullKey],
  );
  return useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
}
