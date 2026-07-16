import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { ConvexProviderWithAuth, type ConvexReactClient } from "convex/react";
import type { TokenBundle } from "@convex-dev/auth/lib/types";
import { api } from "../convex/_generated/api";

/**
 * Storage keys are namespaced by deployment host so tokens from different
 * deployments served on the same origin (e.g. dev and prod apps on
 * localhost) don't collide.
 */
const deploymentHost = new URL(import.meta.env.VITE_CONVEX_URL).host;
const TOKENS_KEY = `convexAuth.tokens.${deploymentHost}`;
const FLOW_KEY = `convexAuth.oauthFlow.${deploymentHost}`;

/** Client-callable mutation refs for each provider wired in convex/auth.ts. */
const PROVIDER_API = {
  google: { signIn: api.auth.signInGoogle, redeem: api.auth.redeemGoogle },
  github: { signIn: api.auth.signInGithub, redeem: api.auth.redeemGithub },
};

/** Providers the example can sign in with. */
export type OAuthProviderName = keyof typeof PROVIDER_API;

/**
 * Refresh this long before the access token actually expires, so a token
 * handed to the Convex client isn't already stale on arrival.
 */
const ACCESS_TOKEN_SKEW_MS = 30 * 1000;

/** The stored token bundle, or `null` if absent, expired, or unreadable. */
function loadTokens(): TokenBundle | null {
  const raw = localStorage.getItem(TOKENS_KEY);
  if (raw === null) {
    return null;
  }
  try {
    const bundle = JSON.parse(raw) as TokenBundle;
    if (bundle.refreshTokenExpiresAt <= Date.now()) {
      localStorage.removeItem(TOKENS_KEY);
      return null;
    }
    return bundle;
  } catch {
    localStorage.removeItem(TOKENS_KEY);
    return null;
  }
}

/** Sign-in and sign-out actions plus the latest sign-in flow error. */
type AuthActions = {
  /** Start the named provider's OAuth flow; navigates away to the provider. */
  signIn: (provider: OAuthProviderName) => Promise<void>;
  /** End the session on the server (best-effort) and locally. */
  signOut: () => Promise<void>;
  /** User-facing message when the last sign-in attempt failed, else null. */
  flowError: string | null;
};

/** Auth state in the shape `ConvexProviderWithAuth`'s `useAuth` prop expects. */
type AuthState = {
  isLoading: boolean;
  isAuthenticated: boolean;
  fetchAccessToken: (args: {
    forceRefreshToken: boolean;
  }) => Promise<string | null>;
};

const AuthStateContext = createContext<AuthState | null>(null);
const AuthActionsContext = createContext<AuthActions | null>(null);

/**
 * Module-level hook handed to `ConvexProviderWithAuth`, which requires a
 * stable `useAuth` reference across renders (a new function identity resets
 * its auth state to loading).
 */
function useAuthState(): AuthState {
  const state = useContext(AuthStateContext);
  if (state === null) {
    throw new Error("useAuthState must be used inside AuthProvider");
  }
  return state;
}

/** The sign-in/sign-out actions provided by {@link AuthProvider}. */
export function useAuthActions(): AuthActions {
  const actions = useContext(AuthActionsContext);
  if (actions === null) {
    throw new Error("useAuthActions must be used inside AuthProvider");
  }
  return actions;
}

/**
 * Take (read and remove) the pending sign-in flow stored at sign-in time:
 * the state that proves this client initiated the flow, and which provider
 * it belongs to (the callback returns only `code`).
 */
function takePendingFlow(): {
  provider: OAuthProviderName;
  state: string;
} | null {
  const raw = localStorage.getItem(FLOW_KEY);
  localStorage.removeItem(FLOW_KEY);
  if (raw === null) {
    return null;
  }
  try {
    const parsed = JSON.parse(raw) as { provider?: unknown; state?: unknown };
    if (
      typeof parsed.provider !== "string" ||
      !(parsed.provider in PROVIDER_API) ||
      typeof parsed.state !== "string"
    ) {
      return null;
    }
    return {
      provider: parsed.provider as OAuthProviderName,
      state: parsed.state,
    };
  } catch {
    return null;
  }
}

/** User-facing messages for the callback's normalized `error` param. */
const FLOW_ERROR_MESSAGES: Record<string, string> = {
  access_denied: "Sign-in was cancelled.",
  expired: "Sign-in took too long. Please try again.",
  oauth_error: "Something went wrong during sign-in. Please try again.",
};

/**
 * Owns the OAuth client flow and the session token lifecycle, and provides
 * an authenticated Convex client to the tree via `ConvexProviderWithAuth`.
 *
 * Flow: `signIn` asks the server for an authorization URL, keeps the minted
 * `state` in localStorage, and navigates away. The provider callback
 * redirects back with a one-time `code` (or `error`); on mount this
 * component redeems `code` + `state` for a token bundle and persists it.
 *
 * Cross-tab coordination (refresh mutex, storage-event sync) is deliberately
 * omitted: the core's refresh grace window absorbs racing tabs, and a
 * sibling tab self-corrects on its next refresh.
 */
export function AuthProvider({
  client,
  children,
}: {
  client: ConvexReactClient;
  children: ReactNode;
}): ReactNode {
  const [tokens, setTokensState] = useState<TokenBundle | null>(loadTokens);
  const [flowError, setFlowError] = useState<string | null>(null);
  // Loading while a callback code is being redeemed; everything else about
  // the initial auth state is known synchronously from localStorage.
  const [redeeming, setRedeeming] = useState<boolean>(() =>
    new URLSearchParams(window.location.search).has("code"),
  );

  // Mirror of `tokens` so fetchAccessToken can stay referentially stable.
  const tokensRef = useRef<TokenBundle | null>(tokens);
  const setTokens = useCallback((bundle: TokenBundle | null) => {
    if (bundle === null) {
      localStorage.removeItem(TOKENS_KEY);
    } else {
      localStorage.setItem(TOKENS_KEY, JSON.stringify(bundle));
    }
    tokensRef.current = bundle;
    setTokensState(bundle);
  }, []);

  useEffect(() => {
    // Read and strip the callback params synchronously, before any await:
    // the StrictMode re-run of this effect then finds a clean URL and
    // no-ops, so the one-time code is only redeemed once.
    const url = new URL(window.location.href);
    const code = url.searchParams.get("code");
    const errorParam = url.searchParams.get("error");
    if (code === null && errorParam === null) {
      return;
    }
    url.searchParams.delete("code");
    url.searchParams.delete("error");
    window.history.replaceState(null, "", url.toString());
    if (errorParam !== null) {
      setFlowError(
        FLOW_ERROR_MESSAGES[errorParam] ?? FLOW_ERROR_MESSAGES.oauth_error,
      );
      setRedeeming(false);
      return;
    }
    if (code === null) {
      return;
    }
    // The state minted at sign-in is this client's proof that it initiated
    // the flow; it's read from storage only, never from the URL (login-CSRF
    // guard), and consumed here whether or not redemption succeeds.
    const pending = takePendingFlow();
    if (pending === null) {
      setFlowError("This sign-in can't be completed here. Please try again.");
      setRedeeming(false);
      return;
    }
    void (async () => {
      const bundle = await client.mutation(
        PROVIDER_API[pending.provider].redeem,
        {
          code,
          state: pending.state,
        },
      );
      if (bundle === null) {
        setFlowError("Sign-in expired. Please try again.");
      } else {
        setTokens(bundle);
      }
      setRedeeming(false);
    })();
    // Runs once on mount; client and setTokens are stable.
  }, []);

  const signIn = useCallback(
    async (provider: OAuthProviderName) => {
      setFlowError(null);
      const { redirect, state } = await client.mutation(
        PROVIDER_API[provider].signIn,
        { redirectTo: window.location.href },
      );
      localStorage.setItem(FLOW_KEY, JSON.stringify({ provider, state }));
      window.location.href = redirect;
    },
    [client],
  );

  const signOut = useCallback(async () => {
    const bundle = tokensRef.current;
    // Clear locally first so the UI signs out even if the server call fails
    // (the session may already be gone).
    setTokens(null);
    if (bundle !== null) {
      try {
        await client.mutation(api.auth.signOut, {
          refreshToken: bundle.refreshToken,
        });
      } catch {
        // Best-effort; local state is already cleared.
      }
    }
  }, [client, setTokens]);

  // Single-flight guard so concurrent token requests share one refresh.
  const refreshInFlight = useRef<Promise<string | null> | null>(null);

  const fetchAccessToken = useCallback(
    async ({ forceRefreshToken }: { forceRefreshToken: boolean }) => {
      const current = tokensRef.current;
      if (current === null) {
        return null;
      }
      const isFresh =
        current.accessTokenExpiresAt > Date.now() + ACCESS_TOKEN_SKEW_MS;
      if (!forceRefreshToken && isFresh) {
        return current.accessToken;
      }
      if (refreshInFlight.current === null) {
        refreshInFlight.current = (async () => {
          try {
            // Re-read storage at call time: another tab may have rotated
            // the refresh token since ours was captured.
            const stored = loadTokens();
            if (stored === null) {
              setTokens(null);
              return null;
            }
            const bundle = await client.mutation(api.auth.refreshSession, {
              refreshToken: stored.refreshToken,
            });
            setTokens(bundle);
            if (bundle === null) {
              return null;
            }
            return bundle.accessToken;
          } finally {
            refreshInFlight.current = null;
          }
        })();
      }
      return await refreshInFlight.current;
    },
    [client, setTokens],
  );

  const authState = useMemo(
    () => ({
      isLoading: redeeming,
      isAuthenticated: tokens !== null,
      fetchAccessToken,
    }),
    [redeeming, tokens, fetchAccessToken],
  );
  const actions = useMemo(
    () => ({ signIn, signOut, flowError }),
    [signIn, signOut, flowError],
  );

  return (
    <AuthStateContext.Provider value={authState}>
      <AuthActionsContext.Provider value={actions}>
        <ConvexProviderWithAuth client={client} useAuth={useAuthState}>
          {children}
        </ConvexProviderWithAuth>
      </AuthActionsContext.Provider>
    </AuthStateContext.Provider>
  );
}
