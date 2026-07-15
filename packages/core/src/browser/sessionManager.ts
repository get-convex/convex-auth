import type { SlimTokenBundle, TokenBundle } from "../lib/types";
import { runWithMutex } from "./mutex";
import {
  JWT_STORAGE_KEY,
  NamespacedStorage,
  REFRESH_TOKEN_STORAGE_KEY,
  TokenStorage,
} from "./storage";

// Retry a failed refresh this long (ms) after the Nth network error. A refresh
// commonly fails transiently on mobile when the app is backgrounded mid-call
// and succeeds once it returns to the foreground.
const RETRY_BACKOFF = [500, 2000];
const RETRY_JITTER = 100;

/**
 * The two auth API calls the core client makes, as an injected interface so
 * this layer never imports Convex: framework bindings implement it (over an
 * HTTP client, to avoid deadlocking the websocket during a refresh), and tests
 * implement it with a fake.
 *
 * The one interface serves SPA and SSR session models. In the default direct
 * model the client holds the refresh token and passes it in, and a refresh
 * returns a full {@link TokenBundle} (including the rotated refresh token to
 * persist). Under SSR the refresh token lives in a server-only httpOnly cookie
 * the browser can't read, so `refreshToken` is `null`, the implementation
 * reaches the real token server-side (e.g. by POSTing to a route that reads
 * the cookie), and a refresh returns an access-only {@link SlimTokenBundle}. The
 * client persists the result according to its shape — see {@link AuthClient},
 * which reads which fields came back rather than being told which model it is
 * in.
 */
export interface AuthApi {
  /**
   * Rotate the refresh token and mint a fresh access token.
   *
   * If a `refreshToken` is supplied, that means the client has access to
   * it and can expect a full {@link TokenBundle} as the return value.
   *
   * Clients without access to the `refreshToken` (SSR when the token is
   * in an httpOnly cookie) should pass `null` and will receive a
   * {@link SlimTokenBundle} as the return value.
   */
  refreshSession: (
    refreshToken: string | null,
  ) => Promise<TokenBundle | SlimTokenBundle | null>;

  /**
   * Revoke the current session. 
   *
   * If the client has access to the `refreshToken` (it's a SPA), it should
   * pass it in. Clients without access to the refresh token (SSR) should pass
   * `null`.
   */
  signOut: (refreshToken: string | null) => Promise<void>;
}

/**
 * Configuration for the {@link AuthClient}.
 */
export interface AuthClientConfig {
  /** The API that the server exposes for auth. */
  authApi: AuthApi;
  /** Where tokens are persisted. */
  storage: TokenStorage;
  /** Namespace for storage keys; typically the deployment URL. */
  storageNamespace: string;
  /** Log refresh/lifecycle steps to the console. */
  verbose?: boolean;
}

/** Auth state that can be subscribed to via {@link AuthClient.subscribe} */
export interface AuthState {
  isLoading: boolean;
  isAuthenticated: boolean;
  token: string | null;
}

type Listener = () => void;

/** The state a fresh client reports until {@link AuthClient.init} has loaded
 * the persisted session. Exported so framework bindings can use it as their
 * pre-hydration snapshot. */
export const INITIAL_AUTH_STATE: AuthState = Object.freeze({
  isLoading: true,
  isAuthenticated: false,
  token: null,
});

function isNetworkError(error: unknown): boolean {
  return (
    error instanceof TypeError &&
    /network|failed to fetch|load failed/i.test(error.message)
  );
}

/**
 * Framework-agnostic owner of the auth session on the client.
 *
 * It persists the {@link TokenBundle} from a sign-in, hands out the access
 * token via {@link AuthClient.fetchAccessToken} (refreshing under a cross-tab
 * lock when forced), keeps in sync across tabs, and exposes a
 * subscribe/snapshot API so any UI framework can render its state. It
 * establishes sessions from provider authentication results. Providers
 * authenticate and sign-in users and call {@link AuthClient.setSession} with
 * a token bundle.
 */
export class AuthClient {
  readonly #authApi: AuthApi;
  readonly #storage: NamespacedStorage;
  readonly #verbose: boolean;
  readonly #lockKey: string;

  #accessToken: string | null = null;
  /**
   * If the client code is running in SSR mode, this value will always be
   * `null`.
   */
  #refreshToken: string | null = null;
  #isLoading = true;
  #initialized = false;

  #snapshot: AuthState = INITIAL_AUTH_STATE;
  readonly #listeners = new Set<Listener>();
  #storageListener: ((event: StorageEvent) => void) | null = null;

  constructor(config: AuthClientConfig) {
    this.#authApi = config.authApi;
    this.#storage = new NamespacedStorage(
      config.storage,
      config.storageNamespace,
    );
    this.#verbose = config.verbose ?? false;
    this.#lockKey = this.#storage.key(REFRESH_TOKEN_STORAGE_KEY);
  }

  // --- Observable store API ------------------------------------------------
  // A minimal subscribe/snapshot store any UI framework can consume (React via
  // useSyncExternalStore, others via their own reactivity).

  /**
   * Subscribe to be notified when the {@link AuthState} changes.
   *
   * Subscribers should call {@link getSnapshot} when notified of a change.
   */
  subscribe = (listener: Listener): (() => void) => {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  };

  /**
   * Returns the latest {@link AuthState} snapshot.
   */
  getSnapshot = (): AuthState => this.#snapshot;

  /** The current access token, or null. */
  getAccessToken(): string | null {
    return this.#accessToken;
  }

  // --- Lifecycle -----------------------------------------------------------

  /**
   * Load any persisted session from storage and start listening for cross-tab
   * changes. Until this resolves, the client reports `isLoading`.
   *
   * Symmetric and repeatable with {@link dispose}: loading the session happens
   * once, but the cross-tab listener is (re)attached on every call, so an
   * `init` after a `dispose` fully restores the client.
   */
  async init(): Promise<void> {
    // Attach before the one-time guard so a dispose()/init() cycle re-attaches
    // the listener rather than skipping it. Idempotent, so repeat calls are
    // harmless.
    this.#attachStorageListener();
    if (this.#initialized) return;
    this.#initialized = true;
    const [accessToken, refreshToken] = await Promise.all([
      this.#storage.get(JWT_STORAGE_KEY),
      this.#storage.get(REFRESH_TOKEN_STORAGE_KEY),
    ]);
    this.#accessToken = accessToken ?? null;
    this.#refreshToken = refreshToken ?? null;
    this.#log(`init: token is null: ${this.#accessToken === null}`);
    this.#isLoading = false;
    this.#notify();
  }

  /**
   * Detach the cross-tab storage listener. Call on teardown. Store subscribers
   * are intentionally left in place — each is removed via the unsubscribe
   * returned by {@link subscribe} — so a later {@link init} restores the client
   * without losing its subscribers.
   */
  dispose(): void {
    if (this.#storageListener !== null && typeof window !== "undefined") {
      window.removeEventListener("storage", this.#storageListener);
      this.#storageListener = null;
    }
  }

  // --- Public actions ------------------------------------------------------

  /**
   * Adopt the session a provider just established. Providers call this after
   * their own sign-in flow returns a session: a full {@link TokenBundle} when
   * the client holds the refresh token, or an access-only {@link SlimTokenBundle}
   * when it is delegated (cookie-held).
   */
  setSession = async (session: TokenBundle | SlimTokenBundle): Promise<void> => {
    await this.#adopt(session);
  };

  /**
   * Revoke the current session on the server (best effort) and clear it
   * locally. The refresh token is passed to the API when the client holds one
   * (`null` when it is delegated, where the API reaches the cookie itself).
   */
  signOut = async (): Promise<void> => {
    const refreshToken = await this.#currentRefreshToken();
    try {
      await this.#authApi.signOut(refreshToken);
    } catch {
      // Usually means we were already signed out, which is fine.
    }
    this.#log("signed out, erasing tokens");
    await this.#storeTokens(null);
  };

  /**
   * The function handed to Convex's `ConvexProviderWithAuth`. Returns the
   * cached access token, or — when `forceRefreshToken` is true (the server
   * rejected the last token or it is near expiry) — rotates the refresh token
   * under a cross-tab lock and returns the fresh access token. Returns `null`
   * (never `undefined`) when there is no usable session.
   */
  fetchAccessToken = async ({
    forceRefreshToken,
  }: {
    forceRefreshToken: boolean;
  }): Promise<string | null> => {
    if (!forceRefreshToken) {
      return this.#accessToken;
    }
    const tokenBeforeLock = this.#accessToken;
    return await runWithMutex(this.#lockKey, async () => {
      // Another tab may have refreshed while we waited for the lock; if so,
      // use its result rather than rotating again.
      if (this.#accessToken !== tokenBeforeLock) {
        this.#log(`using token refreshed by another tab`);
        return this.#accessToken;
      }
      const refreshToken = await this.#currentRefreshToken();
      const result = await this.#withRetry(() =>
        this.#authApi.refreshSession(refreshToken),
      );
      await this.#adopt(result);
      return this.#accessToken;
    });
  };

  // --- Internals -----------------------------------------------------------

  /** The authoritative refresh token: storage (shared across tabs) then memory. */
  async #currentRefreshToken(): Promise<string | null> {
    return (
      (await this.#storage.get(REFRESH_TOKEN_STORAGE_KEY)) ?? this.#refreshToken
    );
  }

  /**
   * Run a refresh `op`, retrying only on transient network errors (backoff +
   * jitter). Shared by both refresh modes — the caller supplies the actual
   * refresh call so this stays agnostic to whether a token is passed.
   */
  async #withRetry<T>(op: () => Promise<T>): Promise<T> {
    let lastError: unknown;
    for (let retry = 0; retry < RETRY_BACKOFF.length; retry++) {
      try {
        return await op();
      } catch (error) {
        lastError = error;
        if (!isNetworkError(error)) break;
        const wait = RETRY_BACKOFF[retry] + RETRY_JITTER * Math.random();
        this.#log(`refresh network error, retry ${retry + 1} in ${wait}ms`);
        await new Promise((resolve) => setTimeout(resolve, wait));
      }
    }
    throw lastError;
  }

  /**
   * Adopt a sign-in or refresh result, persisting it by its shape: a full
   * {@link TokenBundle} stores both tokens; an access-only {@link SlimTokenBundle}
   * stores just the access token (a delegated, cookie-held session); `null`
   * clears the session.
   */
  async #adopt(result: TokenBundle | SlimTokenBundle | null): Promise<void> {
    if (result === null) {
      await this.#storeTokens(null);
    } else if ("refreshToken" in result) {
      await this.#storeTokens(result);
    } else {
      await this.#storeAccessOnly(result);
    }
  }

  /**
   * Set the in-memory + persisted session to `bundle` (or clear it when null),
   * then notify subscribers if the authenticated state changed.
   */
  async #storeTokens(bundle: TokenBundle | null): Promise<void> {
    if (bundle === null) {
      this.#accessToken = null;
      this.#refreshToken = null;
      await this.#storage.remove(JWT_STORAGE_KEY);
      await this.#storage.remove(REFRESH_TOKEN_STORAGE_KEY);
    } else {
      this.#accessToken = bundle.accessToken;
      this.#refreshToken = bundle.refreshToken;
      await this.#storage.set(JWT_STORAGE_KEY, bundle.accessToken);
      await this.#storage.set(REFRESH_TOKEN_STORAGE_KEY, bundle.refreshToken);
    }
    this.#isLoading = false;
    this.#notify();
  }

  /**
   * Store an access-only (delegated, cookie-held) session: set just the access
   * token, never touching the refresh-token slot (there is none in JS). Clearing
   * always goes through {@link #storeTokens}, so this only ever adopts a
   * session. Notifies subscribers.
   */
  async #storeAccessOnly(session: SlimTokenBundle): Promise<void> {
    this.#accessToken = session.accessToken;
    await this.#storage.set(JWT_STORAGE_KEY, session.accessToken);
    this.#isLoading = false;
    this.#notify();
  }

  #attachStorageListener(): void {
    if (typeof window === "undefined") return;
    if (this.#storageListener !== null) return;
    const jwtKey = this.#storage.key(JWT_STORAGE_KEY);
    const refreshKey = this.#storage.key(REFRESH_TOKEN_STORAGE_KEY);
    const listener = (event: StorageEvent) => {
      // Only react to our own storage area (e.g. ignore sessionStorage events
      // when we use localStorage). Keys arrive as separate events, so we handle
      // the JWT and refresh keys independently and never write back here (that
      // would loop).
      if (event.storageArea !== this.#storage.storage) return;
      if (event.key === jwtKey) {
        this.#accessToken = event.newValue;
        this.#log(`synced access token, is null: ${event.newValue === null}`);
        this.#isLoading = false;
        this.#notify();
      } else if (event.key === refreshKey) {
        this.#refreshToken = event.newValue;
      }
    };
    window.addEventListener("storage", listener);
    this.#storageListener = listener;
  }

  #notify(): void {
    this.#snapshot = {
      isLoading: this.#isLoading,
      isAuthenticated: this.#accessToken !== null,
      token: this.#accessToken,
    };
    for (const listener of this.#listeners) listener();
  }

  #log(message: string): void {
    if (this.#verbose) {
      console.debug(`${new Date().toISOString()} [convex-auth] ${message}`);
    }
  }
}
