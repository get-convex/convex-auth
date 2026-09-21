"use client";

import {
  ReactNode,
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  useSyncExternalStore,
} from "react";
import type { AuthSignInApi } from "../browser/ambientSignInClient.ts";
import {
  INITIAL_AUTH_STATE,
  type AuthClient,
} from "../browser/sessionManager.ts";
import type {
  SignInIncomplete,
  SlimTokenBundle,
  TokenBundle,
} from "../lib/types.ts";

export type { AuthSignInApi };

const ConvexAuthSignInApiContext = createContext<AuthSignInApi | undefined>(
  undefined,
);

/**
 * The {@link AuthSignInApi} for the surrounding auth provider.
 *
 * Provider hooks call this to run their sign-in function instead of reaching
 * for `useMutation`/`useAction`, which is what keeps them working under either
 * session model. Throws when used outside an auth provider.
 */
export function useAuthSignInApi(): AuthSignInApi {
  const signInApi = useContext(ConvexAuthSignInApiContext);
  if (signInApi === undefined) {
    throw new Error(
      "useAuthSignInApi must be used within a <ConvexAuthProvider> (or, under " +
        "Next.js, a <ConvexAuthNextjsProvider>).",
    );
  }
  return signInApi;
}

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
};

export const ConvexAuthActionsContext = createContext<
  ConvexAuthActionsContextType | undefined
>(undefined);

/**
 * The bound {@link AuthClient}. Consumed by the provider-author surface
 * (`useAmbientSignInValue` in `react/providers.ts`), not by apps.
 */
export const AuthClientContext = createContext<AuthClient | undefined>(
  undefined,
);

/** The current access token (a JWT), or null when signed out. */
export const ConvexAuthTokenContext = createContext<string | null>(null);

/**
 * A sign-in result as a sign-in hook receives it, under either session model,
 * for {@link PendingSignInContextType.adopt}.
 */
export type AdoptableSignInResult =
  | { status: "complete"; tokens: TokenBundle | SlimTokenBundle }
  | SignInIncomplete
  | { status: "error"; userError: unknown };

/**
 * The sign-in that is waiting on requirements, as `usePendingSignIn` sees it,
 * for an app whose sign-ins can be held for the requirements `R`.
 */
export type PendingSignInState<R extends string = string> = {
  /**
   * The sign-in a provider held on requirements, or `null` when there is
   * none.
   */
  pendingSignIn: SignInIncomplete<R> | null;
  /**
   * `true` when the last pending sign-in was reported expired before it
   * finished. The user starts the sign-in over; the next sign-in result
   * resets it.
   */
  expired: boolean;
  /** Drop the pending sign-in (and the `expired` flag), to start over. */
  cancel: () => void;
};

/** The pending sign-in state plus the entry point the sign-in hooks feed. */
export type PendingSignInContextType = PendingSignInState & {
  /**
   * Take in the result of a sign-in function: adopt the session of a
   * `complete` one, hold an `incomplete` one as the pending sign-in, and mark
   * the pending sign-in expired on `SIGN_IN_EXPIRED`. Other errors leave the
   * pending sign-in as it is, so the user can try its step again.
   */
  adopt: (result: AdoptableSignInResult) => Promise<void>;
};

export const PendingSignInContext = createContext<
  PendingSignInContextType | undefined
>(undefined);

type PendingSignInSlot =
  | { kind: "none" }
  | { kind: "pending"; signIn: SignInIncomplete }
  | { kind: "expired" };

function isSignInExpired(userError: unknown): boolean {
  return (
    typeof userError === "object" &&
    userError !== null &&
    "error" in userError &&
    userError.error === "SIGN_IN_EXPIRED"
  );
}

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

/**
 * The pending sign-in context, for the sign-in hooks. Throws outside an auth
 * provider.
 */
export function usePendingSignInContext(): PendingSignInContextType {
  const context = useContext(PendingSignInContext);
  if (context === undefined) {
    throw new Error(
      "usePendingSignIn must be used within a <ConvexAuthProvider> (or, " +
        "under Next.js, a <ConvexAuthNextjsProvider>).",
    );
  }
  return context;
}

/**
 * Binds an {@link AuthClient} to React and provides the auth, actions,
 * pending sign-in, and token contexts. Rendered by `ConvexAuthProvider` around
 * `ConvexProviderWithAuth`.
 */
export function AuthProvider({
  authClient,
  signInApi,
  children,
}: {
  authClient: AuthClient;
  /** How provider hooks execute their sign-in functions. See {@link AuthSignInApi}. */
  signInApi: AuthSignInApi;
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
    // fine because init()/dispose() are symmetric, and the second init()
    // re-attaches the cross-tab listener the dispose() removed.
    void authClient.init();
    return () => authClient.dispose();
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
    }),
    [authClient],
  );

  // The attempt token proves a first factor, so it lives in memory here and
  // nowhere else: a reload drops it and the user signs in again.
  const [slot, setSlot] = useState<PendingSignInSlot>({ kind: "none" });
  const adopt = useCallback(
    async (result: AdoptableSignInResult) => {
      if (result.status === "complete") {
        await authClient.setSession(result.tokens);
        setSlot({ kind: "none" });
      } else if (result.status === "incomplete") {
        setSlot({ kind: "pending", signIn: result });
      } else if (isSignInExpired(result.userError)) {
        setSlot({ kind: "expired" });
      }
    },
    [authClient],
  );
  const cancel = useCallback(() => setSlot({ kind: "none" }), []);
  const pendingSignIn = useMemo<PendingSignInContextType>(
    () => ({
      pendingSignIn: slot.kind === "pending" ? slot.signIn : null,
      expired: slot.kind === "expired",
      cancel,
      adopt,
    }),
    [slot, cancel, adopt],
  );

  return (
    <AuthClientContext.Provider value={authClient}>
      <ConvexAuthInternalContext.Provider value={authState}>
        <ConvexAuthSignInApiContext.Provider value={signInApi}>
          <ConvexAuthActionsContext.Provider value={actions}>
            <PendingSignInContext.Provider value={pendingSignIn}>
              <ConvexAuthTokenContext.Provider value={state.token}>
                {children}
              </ConvexAuthTokenContext.Provider>
            </PendingSignInContext.Provider>
          </ConvexAuthActionsContext.Provider>
        </ConvexAuthSignInApiContext.Provider>
      </ConvexAuthInternalContext.Provider>
    </AuthClientContext.Provider>
  );
}
