import type { SlimTokenBundle, TokenBundle } from "../lib/types.js";
import { KeyedStore, type SignInValuesReader } from "./keyedStore.js";
import { runWithMutex } from "./mutex.js";
import type {
  AmbientSignInClient,
  AuthSignInApi,
} from "./ambientSignInClient.js";
import { retryOnNetworkError } from "./retry.js";
import {
  JWT_STORAGE_KEY,
  NamespacedStorage,
  REFRESH_TOKEN_STORAGE_KEY,
  TokenStorage,
} from "./storage.js";

/**
 * The refresh and sign-out API for a **SPA** client, where JS holds the
 * refresh token directly.
 *
 * Refreshing rotates the token and returns a full {@link TokenBundle}
 * (including the next refresh token to persist), or `null` when the session is
 * gone.
 */
export interface SpaAuthApi {
  refreshSession: (refreshToken: string) => Promise<TokenBundle | null>;
  signOut: (refreshToken: string) => Promise<void>;
}

/**
 * The refresh and sign-out API for an **SSR** client, where the refresh token
 * lives in an httpOnly cookie that JS can't read.
 *
 * Refreshing goes through an HTTP request to the SSR host, which carries the
 * refresh token in the cookie and replies with a {@link SlimTokenBundle}
 * containing a new access token, or `null` when the session is gone.
 */
export interface SsrAuthApi {
  refreshSession: () => Promise<SlimTokenBundle | null>;
  signOut: () => Promise<void>;
}

/** Config common to both session models. */
interface AuthClientConfigBase {
  /** Where tokens are persisted. */
  storage: TokenStorage;
  /** Namespace for storage keys; typically the deployment URL. */
  storageNamespace: string;
  /**
   * An access token to adopt on {@link AuthClient.init}, typically provided by
   * an SSR host.
   */
  initialAccessToken?: string | null;
  /**
   * Ambient sign-ins to set up while the client is constructed, along with
   * the sign-in api handed to each setup. See {@link AmbientSignInClient}.
   */
  ambientSignIns?: {
    signIns: ReadonlyArray<AmbientSignInClient>;
    signInApi: AuthSignInApi;
  };
  /** Log refresh/lifecycle steps to the console. */
  verbose?: boolean;
}

/**
 * Configuration for the {@link AuthClient}, discriminated by session `mode`.
 *
 * The mode determines who holds the refresh token, and therefore the shape of
 * the auth API the client drives:
 *  - `"spa"`: JS holds the refresh token; the client passes it to a
 *    {@link SpaAuthApi}.
 *  - `"ssr"`: the refresh token is in an httpOnly cookie; a {@link SsrAuthApi}
 *    is called without one and reads the cookie server-side.
 */
export type AuthClientConfig =
  | (AuthClientConfigBase & { mode: "spa"; authApi: SpaAuthApi })
  | (AuthClientConfigBase & { mode: "ssr"; authApi: SsrAuthApi });

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

/**
 * Whether a session carries the refresh token, i.e. is a full
 * {@link TokenBundle} rather than an access-only {@link SlimTokenBundle}.
 *
 * A type predicate rather than an inline check so callers can both branch on it
 * and narrow with it: TypeScript won't narrow a union through a plain boolean
 * held in a variable, and narrowing here is what keeps a cast out of the one
 * path that decides whether a refresh token gets persisted.
 */
function hasRefreshToken(
  session: TokenBundle | SlimTokenBundle,
): session is TokenBundle {
  return "refreshToken" in session;
}

/**
 * Returns the global `window` object when it supports DOM event listeners,
 * otherwise `null`.
 *
 * It will be `null` on platforms like React Native.
 */
function domEventTarget(): Pick<
  Window,
  "addEventListener" | "removeEventListener"
> | null {
  if (typeof window === "undefined") return null;
  if (
    typeof window.addEventListener !== "function" ||
    typeof window.removeEventListener !== "function"
  ) {
    return null;
  }
  return window;
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
  /**
   * Rotate the session, resolving to the new bundle or `null` when the session
   * is gone.
   */
  readonly #refresh: () => Promise<TokenBundle | SlimTokenBundle | null>;
  /** Revoke the session on the server. */
  readonly #signOutInternal: () => Promise<void>;
  readonly #storage: NamespacedStorage;
  readonly #verbose: boolean;
  readonly #lockKey: string;
  readonly #initialAccessToken: string | null;
  /** Which side owns the refresh token. Enforced in {@link AuthClient.#adopt}. */
  readonly #mode: "spa" | "ssr";

  #accessToken: string | null = null;
  /**
   * If the client code is running in SSR mode, this value will always be
   * `null`.
   */
  #refreshToken: string | null = null;
  #isLoading = true;
  #pendingSignIns = 0;
  #initialized = false;

  #snapshot: AuthState = INITIAL_AUTH_STATE;
  readonly #listeners = new Set<Listener>();
  #storageListener: ((event: StorageEvent) => void) | null = null;

  constructor(config: AuthClientConfig) {
    this.#storage = new NamespacedStorage(
      config.storage,
      config.storageNamespace,
    );
    this.#verbose = config.verbose ?? false;
    this.#lockKey = this.#storage.key(REFRESH_TOKEN_STORAGE_KEY);
    this.#initialAccessToken = config.initialAccessToken ?? null;
    this.#mode = config.mode;

    // Bind the mode-specific refresh/sign-out behavior.
    if (config.mode === "spa") {
      const { authApi } = config;
      this.#refresh = async () => {
        const refreshToken = await this.#currentRefreshToken();
        // No token means there's no session to refresh — don't call the API.
        if (refreshToken === null) return null;
        return authApi.refreshSession(refreshToken);
      };
      this.#signOutInternal = async () => {
        const refreshToken = await this.#currentRefreshToken();
        if (refreshToken !== null) await authApi.signOut(refreshToken);
      };
    } else {
      const { authApi } = config;
      // The refresh token is in an httpOnly cookie that the API reads
      // server-side, so it isn't passed directly.
      this.#refresh = () => authApi.refreshSession();
      this.#signOutInternal = () => authApi.signOut();
    }

    // Runs last so setups see a fully initialized client.
    this.#registerAmbientSignIns(config.ambientSignIns);
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

  // --- Ambient sign-in surface ----------------------------------------------

  /**
   * What ambient sign-ins publish, keyed by sign-in id. A setup writes
   * through the scoped view it is handed, and hooks read it back through
   * {@link ambientSignInValues}.
   */
  readonly #ambientValues = new KeyedStore();

  /**
   * A read-only view of the values published under an ambient sign-in's id,
   * for hooks and other bindings to read and subscribe to. Only the sign-in
   * itself can write.
   */
  ambientSignInValues(id: string): SignInValuesReader {
    return this.#ambientValues.forSignInReader(id);
  }

  /** Ambient sign-in onInit callbacks, run once inside {@link init}. */
  readonly #initCallbacks: Array<{ id: string; callback: () => void }> = [];

  /**
   * Run the configured ambient sign-in setups, handing each its scoped
   * views, and collect their onInit callbacks for {@link init} to run.
   * Throws when a sign-in id is invalid or registered twice.
   */
  #registerAmbientSignIns(
    ambientSignIns: AuthClientConfig["ambientSignIns"],
  ): void {
    if (ambientSignIns === undefined) return;
    const seen = new Set<string>();
    for (const { id, setup } of ambientSignIns.signIns) {
      if (!/^[a-zA-Z0-9]+$/.test(id)) {
        throw new Error(
          `Ambient sign-in id "${id}" is invalid; ids must be alphanumeric`,
        );
      }
      if (seen.has(id)) {
        throw new Error(
          `Ambient sign-in id "${id}" is registered twice; each auth ` +
            `method registers once per ConvexAuthProvider`,
        );
      }
      seen.add(id);
      const registration = setup({
        client: this,
        values: this.#ambientValues.forSignIn(id),
        storage: this.#storage.forSignIn(id),
        signInApi: ambientSignIns.signInApi,
      });
      if (registration?.onInit !== undefined) {
        this.#initCallbacks.push({ id, callback: registration.onInit });
      }
    }
  }

  // --- Lifecycle -----------------------------------------------------------

  /**
   * Run ambient sign-in onInit callbacks, load any persisted session from
   * storage, and start listening for cross-tab changes (if applicable).
   * Until this resolves, the client reports `isLoading`.
   *
   * Symmetric and repeatable with {@link dispose}. The callbacks and session
   * load happen once, but the cross-tab listener is (re)attached on every
   * call, so an `init` after a `dispose` fully restores the client.
   */
  async init(): Promise<void> {
    // Attach before the one-time guard so a dispose()/init() cycle re-attaches
    // the listener rather than skipping it. Idempotent, so repeat calls are
    // harmless.
    this.#attachStorageListener();
    if (this.#initialized) return;
    this.#initialized = true;
    // Run ambient sign-in onInit callbacks before anything observable
    // happens, so a withSignInPending call inside one marks loading before
    // the session
    // loads. A callback that throws is logged and skipped, so the others
    // still run and the session still loads.
    for (const { id, callback } of this.#initCallbacks) {
      try {
        callback();
      } catch (error) {
        console.error(
          `[convex-auth] onInit for ambient sign-in "${id}" threw:`,
          error,
        );
      }
    }
    // An initially provided token is considered to be the freshest value, so
    // persist it before the load below reads it back (and so other tabs see
    // it).
    if (this.#initialAccessToken !== null) {
      await this.#storage.set(JWT_STORAGE_KEY, this.#initialAccessToken);
    }
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
   * Detach a registered cross-tab storage listener, if applicable.
   *
   * Call on teardown. Store subscribers are intentionally left in place — each
   * is removed via the unsubscribe returned by {@link subscribe} — so a later
   * {@link init} restores the client without losing its subscribers.
   */
  dispose(): void {
    const target = domEventTarget();
    if (this.#storageListener !== null && target !== null) {
      target.removeEventListener("storage", this.#storageListener);
    }
    this.#storageListener = null;
  }

  // --- Public actions ------------------------------------------------------

  /**
   * Adopt the session a provider just established. Providers call this after
   * their own sign-in flow returns a session: a full {@link TokenBundle} when
   * the client holds the refresh token (SPA), or an access-only {@link
   * SlimTokenBundle} when the refresh token is in a cookie (SSR).
   */
  setSession = async (
    session: TokenBundle | SlimTokenBundle,
  ): Promise<void> => {
    await this.#adopt(session);
  };

  /**
   * Run a sign-in completion while reporting `isLoading`. Use it for work
   * that establishes a session without a user action in the current page,
   * like redeeming an OAuth callback code after a redirect, so the UI shows
   * a loading state instead of flashing unauthenticated. The wrapped
   * function should include its {@link setSession} call, so the loading
   * state holds until the client is authenticated.
   */
  withSignInPending = async <T>(fn: () => Promise<T>): Promise<T> => {
    this.#pendingSignIns++;
    this.#notify();
    try {
      return await fn();
    } finally {
      this.#pendingSignIns--;
      this.#notify();
    }
  };

  /**
   * Revoke the current session on the server and clear it locally.
   */
  signOut = async (): Promise<void> => {
    try {
      await this.#signOutInternal();
    } catch {
      // Usually means we were already signed out, which is fine.
    }
    this.#log("signed out, erasing tokens");
    await this.#storeTokens(null);
  };

  /**
   * The function handed to Convex's `ConvexProviderWithAuth`.
   *
   * Returns a cached access token, or fetches a new token if
   * `forceRefreshToken` is `true`.
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
      const result = await retryOnNetworkError(
        () => this.#refresh(),
        (message) => this.#log(`refresh: ${message}`),
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
   * Adopt a sign-in or refresh result, persisting it by its shape:
   *  - a full {@link TokenBundle} stores both refresh and access tokens
   *  - a {@link SlimTokenBundle} stores just the access token
   *  - `null` clears the session
   */
  async #adopt(result: TokenBundle | SlimTokenBundle | null): Promise<void> {
    if (result === null) {
      await this.#storeTokens(null);
      return;
    }
    // Which shape arrives is a property of the session model, so a mismatch is
    // a wiring bug. Both directions fail loudly rather than degrading, because
    // both degrade in ways that are hard to trace back here.
    if (hasRefreshToken(result)) {
      // Storing this would put a long-lived credential in browser storage,
      // which is the thing the SSR model exists to prevent.
      if (this.#mode === "ssr") {
        throw new Error(
          "[convex-auth] Received a refresh token in an SSR response. The " +
            "auth proxy did not move it into the httpOnly cookie; refusing " +
            "to persist it in browser storage.",
        );
      }
      await this.#storeTokens(result);
    } else {
      // Nothing could rotate the session, so it would die at the first
      // access-token expiry and log the user out with no explanation.
      if (this.#mode === "spa") {
        throw new Error(
          "[convex-auth] Received a session with no refresh token in SPA " +
            "mode. Without one the session cannot be rotated and would " +
            "expire silently.",
        );
      }
      await this.#storeAccessOnly(result);
    }
  }

  /**
   * Stores (or clears in the case of a `null` bundle) the access and refresh
   * tokens.
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
   * Stores just the access token and notifies subscribers.
   */
  async #storeAccessOnly(session: SlimTokenBundle): Promise<void> {
    // Null out/remove any existing refresh token. It shouldn't be set unless
    // this was somehow a client instance configured for SPA use being
    // "upgraded" to SSR use.
    this.#refreshToken = null;
    await this.#storage.remove(REFRESH_TOKEN_STORAGE_KEY);

    this.#accessToken = session.accessToken;
    await this.#storage.set(JWT_STORAGE_KEY, session.accessToken);
    this.#isLoading = false;
    this.#notify();
  }

  #attachStorageListener(): void {
    const target = domEventTarget();
    // This null check guards React Native, where cross-tab storage isn't a thing.
    if (target === null) return;
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
    target.addEventListener("storage", listener);
    this.#storageListener = listener;
  }

  #notify(): void {
    this.#snapshot = {
      // Loading until the persisted session has been read, and again while a
      // sign-in completion is pending (see withSignInPending).
      isLoading: this.#isLoading || this.#pendingSignIns > 0,
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
