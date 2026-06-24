import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useSyncExternalStore,
  type ReactNode,
} from "react";
import type { ConvexHttpClient } from "convex/browser";
import isNetworkError from "is-network-error";
import type { TokenBundle } from "../../lib/tokens.js";
import {
  ensureFreshAccessToken,
  createRefreshDeduper,
  type RefreshMutation,
  type SignOutMutation,
} from "./shared.js";

/**
 * The browser-side API for the core. It owns:
 *  * the session token store
 *  * a React context that carries the Convex client plus the app's core function
 *    references
 *  * the core hooks (`useAuth` for `ConvexProviderWithAuth`, `useSignOut`).
 *
 * Mirrors the server: the core owns sessions and `completeSignIn`; here it owns
 * the token store and `setSession`, which providers consume via `useAuthSession`.
 */

// --- Session token store ----------------------------------------------------
//
// A tiny external store for the session tokens, persisted to localStorage. Lives
// outside React so the Convex auth integration (`fetchAccessToken`) and the UI
// can read/update the same source of truth without prop drilling.

const STORAGE_KEY = "convexAuth.session";

function loadStoredTokens(): TokenBundle | null {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    return raw ? (JSON.parse(raw) as TokenBundle) : null;
  } catch {
    return null;
  }
}

let current: TokenBundle | null = loadStoredTokens();
const listeners = new Set<() => void>();

function getTokens(): TokenBundle | null {
  return current;
}

function setTokens(tokens: TokenBundle | null): void {
  current = tokens;
  try {
    if (tokens) localStorage.setItem(STORAGE_KEY, JSON.stringify(tokens));
    else localStorage.removeItem(STORAGE_KEY);
  } catch {
    // ignore storage failures (e.g. private mode)
  }
  listeners.forEach((l) => l());
}

function subscribeTokens(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

// --- Redirect lifecycle state -----------------------------------------------
//
// Two more tiny external stores so the core can own the "finishing a redirect
// sign-in" lifecycle on the app's behalf. `initializing` is surfaced through
// `useAuth().isLoading` (so `<AuthLoading>` covers it with no app code), and
// `redirectError` is exposed via `useRedirectError()` for the signed-out UI.

let initializing = false;
const initListeners = new Set<() => void>();

// A redirect completion is a one-shot, page-global operation (it consumes a
// single-use code from the URL). This flag ensures it runs exactly once across
// StrictMode's double-mount and any later remount.
let redirectStarted = false;

function getInitializing(): boolean {
  return initializing;
}

function setInitializing(value: boolean): void {
  if (initializing === value) return;
  initializing = value;
  initListeners.forEach((l) => l());
}

function subscribeInitializing(listener: () => void): () => void {
  initListeners.add(listener);
  return () => initListeners.delete(listener);
}

let redirectError: string | null = null;
const errorListeners = new Set<() => void>();

function getRedirectError(): string | null {
  return redirectError;
}

function setRedirectError(message: string | null): void {
  redirectError = message;
  errorListeners.forEach((l) => l());
}

function subscribeError(listener: () => void): () => void {
  errorListeners.add(listener);
  return () => errorListeners.delete(listener);
}

// --- Redirect handlers ------------------------------------------------------
//
// A provider-neutral contract for completing a redirect-based sign-in (an OAuth
// `?code&state`, a magic link, …). Providers supply these; the core runs them
// once on mount. `matches()` is a sync, side-effect-free URL check used to seed
// the loading state without a flash of the signed-out UI; `complete()` does the
// round-trip and resolves to the new session.

export type CallFn = (action: any, args: any) => Promise<any>;

export interface RedirectHandler {
  matches(): boolean;
  complete(args: {
    callActionStandalone: CallFn;
    callMutationOnWebSocket: CallFn;
  }): Promise<TokenBundle | null>;
}

// --- Function reference types -----------------------------------------------
//
// The app owns the export names in `convex/auth.ts`, so the core's function
// references are injected through `<AuthProvider>` rather than imported. The
// types live in the colocated `./shared`; re-exported here for callers that
// import them alongside the React API.
export type { RefreshMutation, SignOutMutation } from "./shared.js";

// --- Context ----------------------------------------------------------------

interface AuthContextValue {
  client: ConvexHttpClient;
  /** Persist (or clear) the session after a provider signs the user in. */
  setSession: (tokens: TokenBundle | null) => void;
  refreshMutation: RefreshMutation;
  signOutMutation: SignOutMutation;
}

const AuthContext = createContext<AuthContextValue | null>(null);

export function AuthProvider({
  client,
  convexClient,
  refreshMutation,
  signOutMutation,
  redirectHandlers = [],
  children,
}: {
  client: ConvexHttpClient;
  convexClient?: { mutation: (reference: any, args: any) => Promise<any> };
  refreshMutation: RefreshMutation;
  signOutMutation: SignOutMutation;
  /**
   * Redirect-based sign-in handlers contributed by providers (e.g.
   * `oauthRedirect(...)`). The core runs the first one whose `matches()` is
   * true on mount, so the app never wires up its own redirect `useEffect`.
   */
  redirectHandlers?: RedirectHandler[];
  children: ReactNode;
}) {
  // Seed `initializing` synchronously on the first render — before the child
  // `ConvexProviderWithAuth` reads `useAuth` — so a pending redirect shows as
  // loading instead of briefly flashing the signed-out UI. Guarded so it runs
  // once; no listeners exist yet, so a direct store write is safe here.
  const redirectSeeded = useRef(false);
  if (!redirectSeeded.current) {
    redirectSeeded.current = true;
    initializing = redirectHandlers.some((h) => h.matches());
  }

  useEffect(() => {
    // Run the completion exactly once. We deliberately don't cancel it on
    // cleanup: StrictMode mounts effects twice, and `complete()` clears the
    // URL's `?code` synchronously on the first run, so cancelling would discard
    // the in-flight result and leave `isLoading` stuck `true`.
    if (redirectStarted) return;
    const pending = redirectHandlers.filter((h) => h.matches());
    if (pending.length === 0) {
      setInitializing(false);
      return;
    }
    redirectStarted = true;
    setInitializing(true);
    void (async () => {
      try {
        const callActionStandalone: CallFn = (action, args) =>
          client.action(action, args);
        // The "authenticate" intent runs the app's `onAuthenticate` mutation on
        // the authenticated reactive client (so it sees the current user).
        const callMutationOnWebSocket: CallFn = convexClient
          ? (mutation, args) => convexClient.mutation(mutation, args)
          : () => {
              throw new Error("convexClient required for authenticate intent");
            };
        const tokens = await pending[0].complete({
          callActionStandalone,
          callMutationOnWebSocket,
        });
        if (tokens) {
          setTokens(tokens);
        }
      } catch (e) {
        setRedirectError(e instanceof Error ? e.message : String(e));
      } finally {
        setInitializing(false);
      }
    })();
    // Handlers are configured once at the root; run this only on mount.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const value = useMemo<AuthContextValue>(
    () => ({ client, setSession: setTokens, refreshMutation, signOutMutation }),
    [client, refreshMutation, signOutMutation],
  );
  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

function useAuthContext(): AuthContextValue {
  const ctx = useContext(AuthContext);
  if (!ctx) {
    throw new Error("Auth hooks must be used within <AuthProvider>.");
  }
  return ctx;
}

/**
 * The seam provider client hooks build on: the Convex client to call auth
 * functions with, and `setSession` to persist the resulting tokens. Client
 * analog of the server's injected `completeSignIn`.
 */
export function useAuthSession(): {
  client: ConvexHttpClient;
  setSession: (tokens: TokenBundle | null) => void;
} {
  const { client, setSession } = useAuthContext();
  return { client, setSession };
}

// --- Core hooks -------------------------------------------------------------

// Coalesce concurrent refreshes so a single rotation isn't fired twice. One
// deduper per tab (module scope is per-tab in the browser, so this is safe
// here — unlike on the server, where it must be per-request).
const refreshDeduper = createRefreshDeduper<TokenBundle | null>();

// Back-off schedule for retrying a refresh that fails with a *network* error
// (the i-th retry waits `RETRY_BACKOFF_MS[i]` plus jitter). Common on mobile,
// where a backgrounded tab loses connectivity mid-call but succeeds once it
// returns to the foreground.
const RETRY_BACKOFF_MS = [500, 2000];
const RETRY_JITTER_MS = 100;

/**
 * Call the `refresh` mutation, retrying transient network failures with
 * back-off. A `null` (dead session) or non-network error returns/throws
 * immediately; only network errors are retried, and once the schedule is
 * exhausted the last error is thrown so the caller can keep the session for a
 * later attempt rather than treating a blip as a sign-out.
 */
async function refreshWithRetry(
  client: ConvexHttpClient,
  refreshMutation: RefreshMutation,
  refreshToken: string,
): Promise<TokenBundle | null> {
  let lastError: unknown;
  for (let attempt = 0; ; attempt++) {
    try {
      return await client.mutation(refreshMutation, { refreshToken });
    } catch (e) {
      lastError = e;
      if (!isNetworkError(e) || attempt >= RETRY_BACKOFF_MS.length) break;
      const wait = RETRY_BACKOFF_MS[attempt] + RETRY_JITTER_MS * Math.random();
      await new Promise((resolve) => setTimeout(resolve, wait));
    }
  }
  throw lastError;
}

/**
 * Auth hook in the shape `ConvexProviderWithAuth` expects. Reads the token store
 * via `useSyncExternalStore` so it re-renders whenever tokens change, and
 * delegates the freshness/refresh decision to the shared core
 * (`ensureFreshAccessToken`), persisting the resulting bundle to localStorage.
 */
export function useAuth() {
  const { client, refreshMutation } = useAuthContext();
  const tokens = useSyncExternalStore(subscribeTokens, getTokens, () => null);
  const isLoading = useSyncExternalStore(
    subscribeInitializing,
    getInitializing,
    () => false,
  );

  const fetchAccessToken = useCallback(
    async ({
      forceRefreshToken,
    }: {
      forceRefreshToken: boolean;
    }): Promise<string | null> => {
      const stored = getTokens();
      if (!stored) return null;
      const next = await ensureFreshAccessToken({
        bundle: stored,
        force: forceRefreshToken,
        refresh: (refreshToken) =>
          refreshDeduper(() =>
            refreshWithRetry(client, refreshMutation, refreshToken),
          ),
      });
      // The store can change while a refresh is in flight (a concurrent
      // `signOut`, or a fresh sign-in via `setSession`). If it did, that newer
      // state wins: don't clobber it with our now-stale result, and don't hand
      // back a token for a session that was replaced.
      const afterwards = getTokens();
      if (afterwards === stored) {
        // No concurrent change. Persist only when the bundle actually changed:
        // rotated (new reference) or cleared on a dead session (`null`). The
        // valid-token fast path returns the same reference, so this is a no-op.
        if (next !== stored) setTokens(next);
        return next?.accessToken ?? null;
      }
      // A concurrent (deduped) refresh already persisted this same result.
      if (afterwards === next) return next?.accessToken ?? null;
      // Something else replaced the session; leave it and let the next fetch
      // observe the current state.
      return null;
    },
    [client, refreshMutation],
  );

  return {
    isLoading,
    isAuthenticated: tokens !== null,
    fetchAccessToken,
  };
}

/**
 * Error from completing a redirect sign-in (if any). The core processes the
 * redirect on mount; the signed-out UI can read this to surface a failure.
 */
export function useRedirectError(): string | null {
  return useSyncExternalStore(subscribeError, getRedirectError, () => null);
}

/** Returns a `signOut()` that clears the local session, then revokes it server-side. */
export function useSignOut(): () => Promise<void> {
  const { client, signOutMutation } = useAuthContext();
  return useCallback(async () => {
    const tokens = getTokens();
    setTokens(null);
    if (tokens) {
      try {
        await client.mutation(signOutMutation, {
          refreshToken: tokens.refreshToken,
        });
      } catch {
        // Local sign-out already happened; ignore server errors.
      }
    }
  }, [client, signOutMutation]);
}
