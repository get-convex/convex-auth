"use client";

import {
  ReactNode,
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useSyncExternalStore,
} from "react";
import { INITIAL_AUTH_STATE, type AuthClient } from "../browser/sessionManager";
import type { SlimTokenBundle, TokenBundle } from "../lib/types";

// React calls this during SSR and initial hydration — before `init()` has read
// storage — so it always reports the loading state. It lives here rather than
// on the core client because server rendering is a React-specific concern.
const getServerSnapshot = () => INITIAL_AUTH_STATE;

/** The value exposed by {@link useAuthActions}. */
export type ConvexAuthActionsContextType = {
  /**
   * Initialize or refresh a session.
   *
   * A SPA client will receive a full {@link TokenBundle} so it can access the
   * refresh token for direct session refreshing. An SSR client will receive a
   * {@link SlimTokenBundle} which doesn't include the refresh token (that
   * value is in an httpOnly cookie, not reachable by client JS code).
   */
  setSession: (session: TokenBundle | SlimTokenBundle) => Promise<void>;
  /** Sign out: revoke the session on the server and clear it locally. */
  signOut: () => Promise<void>;
  /**
   * Run a sign-in completion while the auth state reports loading. Provider
   * clients wrap out-of-band completions — work that establishes a session
   * without a user action in the current page, like redeeming an OAuth
   * callback code after a redirect — so the UI shows `<AuthLoading>` instead
   * of flashing `<Unauthenticated>` mid-completion. Include the `setSession`
   * call in the wrapped function so the loading state holds until the client
   * is authenticated.
   */
  withSignInPending: <T>(fn: () => Promise<T>) => Promise<T>;
};

export const ConvexAuthActionsContext = createContext<
  ConvexAuthActionsContextType | undefined
>(undefined);

/**
 * The bound {@link AuthClient}. Consumed by the provider-author surface
 * (`useAuthClientValue` in `react/providers.ts`), not by apps.
 */
export const AuthClientContext = createContext<AuthClient | undefined>(
  undefined,
);

/** The current access token (a JWT), or null when signed out. */
export const ConvexAuthTokenContext = createContext<string | null>(null);

/**
 * The auth state consumed by Convex's `ConvexProviderWithAuth`. Provided by
 * {@link AuthProvider} and read by the module-level {@link useAuth}.
 */
const ConvexAuthInternalContext = createContext<
  | {
      isLoading: boolean;
      isAuthenticated: boolean;
      fetchAccessToken: (args: {
        forceRefreshToken: boolean;
      }) => Promise<string | null>;
    }
  | undefined
>(undefined);

/**
 * The `useAuth` hook passed to `ConvexProviderWithAuth`. It is a stable
 * module-level function (Convex re-runs the auth handshake if this identity
 * changes) that just reads the context {@link AuthProvider} populates.
 */
export function useAuth() {
  const auth = useContext(ConvexAuthInternalContext);
  if (auth === undefined) {
    throw new Error("useAuth must be used within a <ConvexAuthProvider>.");
  }
  return auth;
}

// onMount callbacks run once per client instance — the same semantics as
// init()'s internal one-time guard — so a StrictMode remount doesn't replay
// them.
const onMountsRan = new WeakSet<AuthClient>();

/**
 * Binds an {@link AuthClient} to React and provides the auth, actions, and
 * token contexts. Rendered by `ConvexAuthProvider` around
 * `ConvexProviderWithAuth`.
 */
export function AuthProvider({
  authClient,
  onMounts,
  children,
}: {
  authClient: AuthClient;
  /**
   * Provider clients' mount-time work, collected from their setups. Run in
   * order, once per client, before `init()`. An onMount that starts a sign-in
   * completion (via `withSignInPending`) marks the state as loading before
   * `init()` runs, so it never briefly reports signed-out.
   */
  onMounts?: ReadonlyArray<() => void>;
  children: ReactNode;
}) {
  const state = useSyncExternalStore(
    authClient.subscribe,
    authClient.getSnapshot,
    getServerSnapshot,
  );

  useEffect(() => {
    // In StrictMode (dev) React runs this mount → cleanup → mount on the same
    // client instance, so it is init'd, disposed, then init'd again. That's
    // fine: init()/dispose() are symmetric, and the second init() re-attaches
    // the cross-tab listener the dispose() removed.
    if (!onMountsRan.has(authClient)) {
      onMountsRan.add(authClient);
      onMounts?.forEach((onMount) => onMount());
    }
    void authClient.init();
    return () => authClient.dispose();
    // `onMounts` is read once per client, like the props that construct it.
  }, [authClient]);

  const fetchAccessToken = useCallback(
    (args: { forceRefreshToken: boolean }) => authClient.fetchAccessToken(args),
    [authClient],
  );

  const authState = useMemo(
    () => ({
      isLoading: state.isLoading,
      isAuthenticated: state.isAuthenticated,
      fetchAccessToken,
    }),
    [state.isLoading, state.isAuthenticated, fetchAccessToken],
  );

  const actions = useMemo<ConvexAuthActionsContextType>(
    () => ({
      setSession: authClient.setSession,
      signOut: authClient.signOut,
      withSignInPending: authClient.withSignInPending,
    }),
    [authClient],
  );

  return (
    <AuthClientContext.Provider value={authClient}>
      <ConvexAuthInternalContext.Provider value={authState}>
        <ConvexAuthActionsContext.Provider value={actions}>
          <ConvexAuthTokenContext.Provider value={state.token}>
            {children}
          </ConvexAuthTokenContext.Provider>
        </ConvexAuthActionsContext.Provider>
      </ConvexAuthInternalContext.Provider>
    </AuthClientContext.Provider>
  );
}
