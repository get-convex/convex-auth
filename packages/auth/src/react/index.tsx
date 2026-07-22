/**
 * React bindings for `@robelest/convex-auth/react`.
 *
 * @module
 */

"use client";

import {
  createContext,
  useCallback,
  useContext,
  useSyncExternalStore,
  type ReactElement,
  type ReactNode,
} from "react";

import type { AuthApiRefs, AuthClient } from "../browser/index";
import type { AuthState, SignInOverloads } from "../client/core/types";

type AnyAuthClient = AuthClient<AuthApiRefs<boolean, boolean, boolean>>;

const AuthClientContext = createContext<AnyAuthClient | null>(null);

/** Provide an app-owned auth client to descendants. */
export function ConvexAuthProvider({
  auth,
  children,
}: {
  auth: AnyAuthClient;
  children: ReactNode;
}): ReactElement {
  return <AuthClientContext.Provider value={auth}>{children}</AuthClientContext.Provider>;
}

const NO_PROVIDER_MESSAGE =
  "No auth client found. Wrap the component tree in <ConvexAuthProvider auth={...}> " +
  "before using the auth hooks.";

/**
 * Read the app-owned auth client from context, throwing a clear error when no
 * {@link ConvexAuthProvider} is above. Failing fast on a missing provider — the
 * same contract as Svelte's `useConvexAuth()` — is far easier to debug than a
 * silent, perpetual `loading` state, and lets the hooks return non-nullable
 * values so callers never have to guard against an absent client.
 */
function useAuthClientOrThrow(): AnyAuthClient {
  const client = useContext(AuthClientContext);
  if (client === null) {
    throw new Error(NO_PROVIDER_MESSAGE);
  }
  return client;
}

/** Read the current auth state. Throws if no {@link ConvexAuthProvider} is above. */
export function useAuth(): AuthState {
  const client = useAuthClientOrThrow();
  // Memoize so `useSyncExternalStore` does not tear down and re-create the
  // subscription on every render — it only re-subscribes when `client` changes.
  const subscribe = useCallback(
    (onStoreChange: () => void) => client.subscribe(onStoreChange),
    [client],
  );
  // Server snapshot honors the SSR token seed carried by `client.getSnapshot()`
  // (via the `token` option) instead of always reporting `loading`, so a
  // server-seeded signed-in/out state hydrates without a loading flash.
  const getSnapshot = useCallback(() => client.getSnapshot(), [client]);
  return useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
}

/** Render children only when signed in; supports a render prop receiving the JWT. */
export function SignedIn({
  children,
}: {
  children: ReactNode | ((token: string) => ReactNode);
}): ReactElement | null {
  const state = useAuth();
  if (state.status !== "signedIn") return null;
  return <>{typeof children === "function" ? children(state.token) : children}</>;
}

/** Render children only when signed out. */
export function SignedOut({ children }: { children: ReactNode }): ReactElement | null {
  const state = useAuth();
  return state.status === "signedOut" ? <>{children}</> : null;
}

/**
 * Render children only while auth is still resolving or Convex is confirming a
 * stored token.
 */
export function AuthLoading({ children }: { children: ReactNode }): ReactElement | null {
  const state = useAuth();
  return state.status === "loading" ? <>{children}</> : null;
}

/**
 * The auth actions (`signIn`, `signOut`), always callable. Throws if no
 * {@link ConvexAuthProvider} is above — matching Svelte's non-nullable
 * `signIn`/`signOut`, so callers never have to null-check the actions.
 */
export function useAuthActions(): {
  signIn: SignInOverloads;
  signOut: () => Promise<void>;
} {
  const client = useAuthClientOrThrow();
  return { signIn: client.signIn, signOut: client.signOut };
}

/**
 * The underlying imperative client, for factor flows (`client.totp.*`,
 * `client.passkey.*`, `client.device.*`) and low-level methods (`completeOAuth`,
 * `param`, `initialize`). Throws if no {@link ConvexAuthProvider} is above.
 */
export function useConvexAuthClient(): AnyAuthClient {
  return useAuthClientOrThrow();
}
