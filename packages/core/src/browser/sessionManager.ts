import type { TokenBundle } from "../lib/types";
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
 * The two auth API calls the core client makes. Kept as an injected interface
 * so this layer never imports Convex: framework bindings should implement it
 * (over an HTTP client, to avoid deadlocking the websocket during a refresh),
 * and tests implement it with a fake.
 */
export interface AuthApi {
  /**
   * Rotate the refresh token and mint a fresh access token. `null` means the
   * session is gone (unknown or expired refresh token) — treat as signed out.
   */
  refreshSession: (refreshToken: string) => Promise<TokenBundle | null>;
  /** Revoke the session for a refresh token. Idempotent. */
  signOut: (refreshToken: string) => Promise<void>;
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

/** The reactive snapshot the React layer subscribes to. */
export interface AuthState {
  isLoading: boolean;
  isAuthenticated: boolean;
  token: string | null;
}

type Listener = () => void;

const INITIAL_AUTH_STATE: AuthState = Object.freeze({
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

  // --- Reactive store API (for React's useSyncExternalStore) ---------------

  subscribe = (listener: Listener): (() => void) => {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  };

  getSnapshot = (): AuthState => this.#snapshot;

  // Just a static value for now. Will carry future SSR state.
  getServerSnapshot = (): AuthState => INITIAL_AUTH_STATE;

  /** The current access token, or null. */
  getAccessToken(): string | null {
    return this.#accessToken;
  }

  // --- Lifecycle -----------------------------------------------------------

  /**
   * Load any persisted session from storage and start listening for cross-tab
   * changes. Idempotent. Until this resolves, the client reports `isLoading`.
   */
  async init(): Promise<void> {
    if (this.#initialized) return;
    this.#initialized = true;
    this.#attachStorageListener();
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

  /** Detach listeners. Call on teardown. */
  dispose(): void {
    if (this.#storageListener !== null && typeof window !== "undefined") {
      window.removeEventListener("storage", this.#storageListener);
      this.#storageListener = null;
    }
    this.#listeners.clear();
  }

  // --- Public actions ------------------------------------------------------

  /**
   * Adopt the session a provider just established. Providers call this after
   * their own sign-in flow returns a {@link TokenBundle}.
   */
  setSession = async (bundle: TokenBundle): Promise<void> => {
    await this.#storeTokens(bundle);
  };

  /**
   * Revoke the current session on the server (best effort) and clear it
   * locally.
   */
  signOut = async (): Promise<void> => {
    const refreshToken = await this.#currentRefreshToken();
    if (refreshToken !== null) {
      try {
        await this.#authApi.signOut(refreshToken);
      } catch {
        // Usually means we were already signed out, which is fine.
      }
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
      if (refreshToken === null) {
        this.#log("no refresh token, cannot refresh");
        return null;
      }
      const bundle = await this.#refreshWithRetry(refreshToken);
      await this.#storeTokens(bundle);
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

  async #refreshWithRetry(refreshToken: string): Promise<TokenBundle | null> {
    let lastError: unknown;
    for (let retry = 0; retry < RETRY_BACKOFF.length; retry++) {
      try {
        return await this.#authApi.refreshSession(refreshToken);
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

  #attachStorageListener(): void {
    if (typeof window === "undefined") return;
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
