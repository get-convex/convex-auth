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

const LOADING: AuthState = { status: "loading", token: null };

/** Read the current auth state. */
export function useAuth(): AuthState {
  const client = useContext(AuthClientContext);
  // Memoize so `useSyncExternalStore` does not tear down and re-create the
  // subscription on every render — it only re-subscribes when `client` changes.
  const subscribe = useCallback(
    (onStoreChange: () => void) => (client ? client.subscribe(onStoreChange) : () => {}),
    [client],
  );
  // Server snapshot honors the SSR token seed carried by `client.getSnapshot()`
  // (via the `token` option) instead of always reporting `loading`, so a
  // server-seeded signed-in/out state hydrates without a loading flash.
  const getSnapshot = useCallback(() => (client ? client.getSnapshot() : LOADING), [client]);
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
 * The auth actions. Returns `undefined` members when no auth client is
 * available from {@link ConvexAuthProvider}.
 */
export function useAuthActions(): {
  signIn: SignInOverloads | undefined;
  signOut: (() => Promise<void>) | undefined;
} {
  const client = useContext(AuthClientContext);
  return { signIn: client?.signIn, signOut: client?.signOut };
}

/**
 * The underlying imperative client, for factor flows (`client.totp.*`,
 * `client.passkey.*`, `client.device.*`) and low-level methods (`completeOAuth`,
 * `param`, `initialize`). Returns `null` when no auth client is available.
 */
export function useConvexAuthClient(): AnyAuthClient | null {
  return useContext(AuthClientContext);
}
