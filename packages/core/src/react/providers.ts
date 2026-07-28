/**
 * React building blocks for provider-client authors, exported at
 * `@convex-dev/auth/react/providers`. Apps don't need anything here — provider
 * modules (OAuth, and future auth methods) use these to expose their state as
 * hooks.
 *
 * A provider client registers its actions and flow state in the auth client's
 * keyed store from its {@link AuthProviderClientSetup} (passed to
 * `ConvexAuthProvider`'s `use` prop); its hooks read them back with
 * {@link useAuthClientValue}.
 *
 * @module
 */
"use client";

import { useCallback, useContext, useSyncExternalStore } from "react";
import { AuthClientContext } from "./client";

export { KeyedStore } from "../browser/keyedStore";
export type {
  AuthProviderClientContext,
  AuthProviderClientSetup,
  MutationCaller,
} from "../browser/providerSetup";

/**
 * Subscribe to a value in the auth client's keyed store. Returns `undefined`
 * when nothing is registered at `key` — typically meaning the provider's
 * setup wasn't passed to `ConvexAuthProvider`'s `use` prop, which provider
 * hooks should surface as an error.
 */
export function useAuthClientValue<T>(key: string): T | undefined {
  const client = useContext(AuthClientContext);
  if (client === undefined) {
    throw new Error(
      "useAuthClientValue must be used within a <ConvexAuthProvider>.",
    );
  }
  const subscribe = useCallback(
    (listener: () => void) => client.store.subscribe(key, listener),
    [client, key],
  );
  const getSnapshot = useCallback(
    // Setups run while the client is constructed, so the store is populated
    // during SSR too — the server snapshot is the same read.
    () => client.store.get<T>(key),
    [client, key],
  );
  return useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
}
