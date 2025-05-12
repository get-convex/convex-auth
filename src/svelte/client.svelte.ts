/**
 * Svelte implementation of Convex Auth client.
 */
import { getContext, setContext } from "svelte";
import type {
  SignInAction,
  SignOutAction,
} from "../server/implementation/index.js";
import { AuthClient } from "./clientType.js";
import type { ConvexAuthServerState, TokenStorage } from "./index.svelte.js";
import isNetworkError from "is-network-error";
import { Value } from "convex/values";
import { setupConvex } from "convex-svelte";
import { ConvexClient, ConvexClientOptions } from "convex/browser";

// Retry after this much time, based on the retry number.
const RETRY_BACKOFF = [500, 2000]; // In ms
const RETRY_JITTER = 100; // In ms

// Storage keys
const VERIFIER_STORAGE_KEY = "__convexAuthOAuthVerifier";
const JWT_STORAGE_KEY = "__convexAuthJWT";
const REFRESH_TOKEN_STORAGE_KEY = "__convexAuthRefreshToken";
const SERVER_STATE_FETCH_TIME_STORAGE_KEY = "__convexAuthServerStateFetchTime";

// Convex auth context key
const AUTH_CONTEXT_KEY = "$$_convexAuth";

/**
 * Create a Convex Auth client with Svelte reactivity
 */
export function createAuthClient({
  client,
  getServerState,
  onChange,
  storage,
  storageNamespace,
  replaceURL,
  options,
}: {
  client: AuthClient;
  getServerState?: () => ConvexAuthServerState;
  onChange?: () => Promise<unknown>;
  storage: TokenStorage | null;
  storageNamespace: string;
  replaceURL: (relativeUrl: string) => void | Promise<void>;
  options?: ConvexClientOptions;
}) {
  // Initialize state with reactive variables
  const state = $state({
    token: getServerState?.()._state.token ?? null,
    refreshToken: getServerState?.()._state.refreshToken ?? null,
    isLoading: getServerState?.()._state.token === null,
    isRefreshingToken: false,
  });
  const isAuthenticated = $derived(state.token !== null);

  // Debug logging
  const logVerbose = (message: string) => {
    if (options?.verbose) {
      console.log(`${new Date().toISOString()} ${message}`);
      client.logger?.logVerbose(message);
    }
  };

  // Create storage helpers with namespace
  const { storageSet, storageGet, storageRemove } = useNamespacedStorage(
    storage,
    storageNamespace,
  );

  // Token management
  const setToken = async (
    args:
      | { shouldStore: true; tokens: { token: string; refreshToken: string } }
      | { shouldStore: false; tokens: { token: string } }
      | { shouldStore: boolean; tokens: null },
  ) => {
    const wasAuthenticated = state.token !== null;
    let newToken: string | null;

    if (args.tokens === null) {
      state.token = null;
      state.refreshToken = null;
      if (args.shouldStore) {
        await storageRemove(REFRESH_TOKEN_STORAGE_KEY);
        await storageRemove(JWT_STORAGE_KEY);
      }
      newToken = null;
    } else {
      const { token: value } = args.tokens;
      if (args.shouldStore) {
        const { refreshToken } = args.tokens;
        state.token = value;
        state.refreshToken = refreshToken;
        await storageSet(JWT_STORAGE_KEY, value);
        await storageSet(REFRESH_TOKEN_STORAGE_KEY, refreshToken);

        // Store server state fetch time
        if (getServerState && !state.isRefreshingToken) {
          await storageSet(
            SERVER_STATE_FETCH_TIME_STORAGE_KEY,
            `${getServerState()._timeFetched}`,
          );
        }
      }
      newToken = value;
    }

    if (wasAuthenticated !== (newToken !== null)) {
      await onChange?.();
    }

    state.isLoading = false;
  };

  // Load tokens from storage on initialization
  $effect(() => {
    const loadTokens = async () => {
      if (getServerState?.()._state) {
        // Check if the server state is newer than what we have in localStorage
        const storedTimeFetched = await storageGet(
          SERVER_STATE_FETCH_TIME_STORAGE_KEY,
        );
        const serverIsNewer =
          !storedTimeFetched ||
          getServerState()._timeFetched > +storedTimeFetched;

        if (serverIsNewer) {
          // Server state is newer, use it
          const { token, refreshToken } = getServerState()._state;

          // Save the server fetch time
          await storageSet(
            SERVER_STATE_FETCH_TIME_STORAGE_KEY,
            getServerState()._timeFetched.toString(),
          );

          logVerbose(
            `Using server state tokens (newer than storage), null? ${token === null || refreshToken === null}`,
          );

          // Apply the tokens
          await setToken({
            shouldStore: true,
            tokens:
              token === null || refreshToken === null
                ? null
                : { token, refreshToken },
          });
        } else {
          // localStorage has newer data, load from there
          logVerbose(`Using localStorage tokens (newer than server state)`);
          await loadFromStorage();
        }
        return;
      }

      // No server state, try localStorage
      await loadFromStorage();
    };

    // Helper to load from storage
    const loadFromStorage = async () => {
      try {
        const [storedToken, storedRefreshToken] = await Promise.all([
          storageGet(JWT_STORAGE_KEY),
          storageGet(REFRESH_TOKEN_STORAGE_KEY),
        ]);

        if (storedToken && storedRefreshToken) {
          logVerbose("Loaded tokens from storage");
          await setToken({
            shouldStore: false,
            tokens: { token: storedToken },
          });
        } else {
          // No tokens in storage
          logVerbose("No tokens in storage");
          state.isLoading = false;
        }
      } catch (e) {
        console.error("Error loading tokens from storage:", e);
        state.isLoading = false;
      }
    };

    // Initialize tokens
    void loadTokens();
  });

  // Check URL for authentication code
  $effect(() => {
    const checkUrlForCode = async () => {
      if (typeof window === "undefined") {
        return;
      }

      const url = new URL(window.location.href);
      const code = url.searchParams.get("code");

      if (code) {
        logVerbose("found code in URL, removing");
        url.searchParams.delete("code");
        await replaceURL(
          url.pathname + url.search + (url.hash ? url.hash : ""),
        );

        // Get verifier from storage
        const verifier = await storageGet(VERIFIER_STORAGE_KEY);
        await storageRemove(VERIFIER_STORAGE_KEY);

        logVerbose(`verifying code, have verifier: ${!!verifier}`);
        try {
          const response = await verifyCode({
            code,
            verifier: verifier ?? undefined,
          });

          // Extract tokens from the response
          if (response.tokens) {
            // If tokens is available in the response
            await setToken({
              shouldStore: true,
              tokens: response.tokens,
            });
            logVerbose("signed in with code from URL using tokens object");
          } else {
            // No valid tokens in the response
            console.error("No valid tokens in auth response:", response);
            state.isLoading = false;
            return;
          }

          logVerbose("signed in with code from URL");
        } catch (e) {
          console.error("Failed to verify code from URL:", e);
          state.isLoading = false;
        }
      }
    };

    // Check for code in URL
    void checkUrlForCode();
  });

  // Listen for storage events (for cross-tab sync)
  $effect(() => {
    if (typeof window === "undefined") {
      return;
    }

    const storageListener = (event: StorageEvent) => {
      if (event.storageArea !== storage) {
        return;
      }

      // Check if our JWT token changed
      if (event.key === storageKey(JWT_STORAGE_KEY, storageNamespace)) {
        const value = event.newValue;
        logVerbose(`synced access token, is null: ${value === null}`);

        // Update our state without writing back to storage
        void setToken({
          shouldStore: false,
          tokens: value === null ? null : { token: value },
        });
      }
    };

    window.addEventListener("storage", storageListener);
    return () => window.removeEventListener("storage", storageListener);
  });

  // Prevent accidental navigation away from the page during token refresh.
  $effect(() => {
    if (typeof window === "undefined") {
      return;
    }

    const beforeUnloadListener = (e: BeforeUnloadEvent) => {
      if (state.isRefreshingToken) {
        e.preventDefault();
        const confirmationMessage =
          "Are you sure you want to leave? Your changes may not be saved.";
        e.returnValue = confirmationMessage;
        return confirmationMessage;
      }
    };

    window.addEventListener("beforeunload", beforeUnloadListener);
    return () =>
      window.removeEventListener("beforeunload", beforeUnloadListener);
  });

  // Auth methods
  const verifyCode = async (
    args: { code: string; verifier?: string } | { refreshToken: string },
  ) => {
    let lastError;
    // Retry the call if it fails due to a network error.
    // This is especially common in mobile apps where an app is backgrounded
    // while making a call and hits a network error, but will succeed with a
    // retry once the app is brought to the foreground.
    let retry = 0;
    while (retry < RETRY_BACKOFF.length) {
      try {
        return await client.unauthenticatedCall(
          "auth:signIn" as unknown as SignInAction,
          "code" in args
            ? { params: { code: args.code }, verifier: args.verifier }
            : args,
        );
      } catch (e) {
        lastError = e;
        if (!isNetworkError(e)) {
          break;
        }
        const wait = RETRY_BACKOFF[retry] + RETRY_JITTER * Math.random();
        retry++;
        logVerbose(
          `verifyCode failed with network error, retry ${retry} of ${RETRY_BACKOFF.length} in ${wait}ms`,
        );
        await new Promise((resolve) => setTimeout(resolve, wait));
      }
    }
    throw lastError;
  };

  /**
   * Get an access token from the server using the stored refresh token.
   * If the refresh token is invalid, it will be cleared.
   *
   * If `options.forceRefreshToken` is true, a new access token will always be obtained
   * from the server. Otherwise, if an access token is cached, it will be used
   * without revalidating it with the server.
   *
   * @param {object} [options]
   *
   * @return {Promise<string | null>} The access token, or null if none is
   *   available.
   */
  const fetchAccessToken = async (options?: {
    forceRefreshToken?: boolean;
  }): Promise<string | null> => {
    const { forceRefreshToken = false } = options ?? {};
    logVerbose(`fetchAccessToken forceRefreshToken=${forceRefreshToken}`);

    // Return the existing token if we have one and aren't forcing a refresh
    if (state.token !== null && !forceRefreshToken) {
      logVerbose(`returning existing token, is null: ${state.token === null}`);
      return state.token;
    }

    // From here on, we need to potentially refresh the token.
    // We use a mutex to ensure only one tab/window attempts the refresh.

    const tokenBeforeLockAquisition = state.token;

    return await browserMutex(REFRESH_TOKEN_STORAGE_KEY, async () => {
      const tokenAfterLockAquisition = state.token;
      // Another tab or frame might have refreshed the token while we waited for the lock.
      if (tokenAfterLockAquisition !== tokenBeforeLockAquisition) {
        logVerbose(
          `returning synced token, is null: ${tokenAfterLockAquisition === null}`,
        );
        return tokenAfterLockAquisition;
      }

      // We hold the lock, proceed with refreshing the token.
      try {
        state.isRefreshingToken = true;

        // Get the refresh token from storage
        const refreshToken = await storageGet(REFRESH_TOKEN_STORAGE_KEY);
        if (!refreshToken) {
          logVerbose("no refresh token found in storage");
          // Ensure token state is null if no refresh token exists
          if (state.token !== null) {
            await setToken({ shouldStore: true, tokens: null });
          }
          return null;
        }

        logVerbose("using refresh token to get new access token");
        const response = await verifyCode({ refreshToken });

        if (response.tokens) {
          logVerbose(
            `retrieved tokens, is null: ${response.tokens.token === null}`,
          );
          await setToken({ shouldStore: true, tokens: response.tokens });
          return response.tokens.token;
        } else {
          logVerbose(
            "no tokens in refresh token response, clearing stored tokens",
          );
          // Clear tokens if refresh failed but didn't throw
          await setToken({ shouldStore: true, tokens: null });
          return null;
        }
      } catch (e) {
        console.error("Failed to refresh token:", e);

        // Clear tokens on failure
        await setToken({ shouldStore: true, tokens: null });
        return null;
      } finally {
        state.isRefreshingToken = false;
      }
    });
  };

  const signIn = async (
    provider: string,
    params?: FormData | Record<string, Value>,
  ) => {
    logVerbose(`signIn provider=${provider}`);

    try {
      // Get verifier if it exists
      const verifier = (await storageGet(VERIFIER_STORAGE_KEY)) ?? undefined;
      await storageRemove(VERIFIER_STORAGE_KEY);

      const finalParams =
        params instanceof FormData
          ? Object.fromEntries(params.entries())
          : (params ?? {});

      const result = await client.authenticatedCall(
        "auth:signIn" as unknown as SignInAction,
        { provider, params: finalParams, verifier },
      );

      if (result.redirect !== undefined) {
        const url = new URL(result.redirect);
        // For redirect flows (OAuth or magic links)
        // Store the verifier for the redirect flow
        if (result.verifier) {
          await storageSet(VERIFIER_STORAGE_KEY, result.verifier);
        }

        if (typeof window !== "undefined") {
          window.location.href = url.toString();
        }

        return { signingIn: false, redirect: url }; // User will need to complete the flow
      } else if (result.tokens !== undefined) {
        // For direct sign-in flows or token refresh
        logVerbose(
          `signed in and got tokens, is null: ${result.tokens === null}`,
        );
        await setToken({ shouldStore: true, tokens: result.tokens });

        // Return success based on whether we got valid tokens
        return { signingIn: result.tokens !== null };
      }

      // Default case - not signed in
      return { signingIn: false };
    } catch (e) {
      console.error("Failed to sign in:", e);
      throw e;
    }
  };

  const signOut = async (): Promise<void> => {
    logVerbose("signOut");

    try {
      // This can fail if the backend is unavailable, that's ok we will
      // still sign out on the client.
      await client.authenticatedCall(
        "auth:signOut" as unknown as SignOutAction,
      );
    } catch (e) {
      // Ignore any errors, they are usually caused by being
      // already signed out, which is ok.
      if (e instanceof Error) {
        logVerbose(`signOut error (ignored): ${e.message}`);
      }
    }

    // Always clear tokens locally, even if server call failed
    logVerbose(`signed out, erasing tokens`);

    await setToken({ shouldStore: true, tokens: null });
  };

  // Expose the auth API
  const authApi = {
    get isLoading() {
      return state.isLoading;
    },
    get isAuthenticated() {
      return isAuthenticated;
    },
    get token() {
      return state.token;
    },
    fetchAccessToken,
    signIn,
    signOut,
  };

  return authApi;
}

/**
 * Get the Convex Auth client from the context
 */
export function useAuth() {
  const authClient = getContext(AUTH_CONTEXT_KEY);
  if (!authClient) {
    throw new Error(
      "No ConvexAuth client found in context. Did you forget to use createAuthProvider?",
    );
  }
  return authClient;
}

/**
 * Set the Convex Auth client in the context
 */
export function setConvexAuthContext(
  authClient: ReturnType<typeof createAuthClient>,
) {
  setContext(AUTH_CONTEXT_KEY, authClient);
  return authClient;
}

/**
 * Get the Convex Auth client from the context
 */
export function getConvexAuthContext() {
  return getContext<ReturnType<typeof createAuthClient>>(AUTH_CONTEXT_KEY);
}

/**
 * Create a fully namespaced key for storage
 */
function storageKey(key: string, namespace: string): string {
  return `${namespace}:${key}`;
}

/**
 * Create an in-memory storage implementation
 */
function createInMemoryStorage(): TokenStorage {
  // Create a closure around the map to maintain state
  const map = new Map<string, string>();

  return {
    getItem: (key) => map.get(key) ?? null,
    setItem: (key, value) => {
      map.set(key, value);
    },
    removeItem: (key) => {
      map.delete(key);
    },
  };
}

/**
 * Helper to create namespaced storage functions
 */
function useNamespacedStorage(
  persistentStorage: TokenStorage | null,
  namespace: string,
) {
  // Use either provided storage or create in-memory storage
  const storage = persistentStorage ?? createInMemoryStorage();

  // Normalize namespace to alphanumeric only (for compatibility with RN)
  const normalizedNamespace = namespace.replace(/[^a-zA-Z0-9]/g, "");

  const storageGet = async (key: string): Promise<string | null> => {
    try {
      const value = await storage.getItem(storageKey(key, normalizedNamespace));
      return value ?? null;
    } catch (e) {
      console.error(`Failed to get ${key} from storage:`, e);
      return null;
    }
  };

  const storageSet = async (key: string, value: string): Promise<void> => {
    try {
      await storage.setItem(storageKey(key, normalizedNamespace), value);
    } catch (e) {
      console.error(`Failed to set ${key} in storage:`, e);
    }
  };

  const storageRemove = async (key: string): Promise<void> => {
    try {
      await storage.removeItem(storageKey(key, normalizedNamespace));
    } catch (e) {
      console.error(`Failed to remove ${key} from storage:`, e);
    }
  };

  return { storageSet, storageGet, storageRemove };
}

// In the browser, executes the callback as the only tab / frame at a time.
export async function browserMutex<T>(
  key: string,
  callback: () => Promise<T>,
): Promise<T> {
  if (typeof window === "undefined") {
    return callback();
  }
  const lockManager = window?.navigator?.locks;
  return lockManager !== undefined
    ? await lockManager.request(key, callback)
    : await manualMutex(key, callback);
}

function getMutexValue(key: string): {
  currentlyRunning: Promise<void> | null;
  waiting: Array<() => Promise<void>>;
} {
  if ((globalThis as any).__convexAuthMutexes === undefined) {
    (globalThis as any).__convexAuthMutexes = {} as Record<
      string,
      {
        currentlyRunning: Promise<void>;
        waiting: Array<() => Promise<void>>;
      }
    >;
  }
  let mutex = (globalThis as any).__convexAuthMutexes[key];
  if (mutex === undefined) {
    (globalThis as any).__convexAuthMutexes[key] = {
      currentlyRunning: null,
      waiting: [],
    };
  }
  mutex = (globalThis as any).__convexAuthMutexes[key];
  return mutex;
}

function setMutexValue(
  key: string,
  value: {
    currentlyRunning: Promise<void> | null;
    waiting: Array<() => Promise<void>>;
  },
) {
  (globalThis as any).__convexAuthMutexes[key] = value;
}

async function enqueueCallbackForMutex(
  key: string,
  callback: () => Promise<void>,
) {
  const mutex = getMutexValue(key);
  if (mutex.currentlyRunning === null) {
    setMutexValue(key, {
      currentlyRunning: callback().finally(() => {
        const nextCb = getMutexValue(key).waiting.shift();
        getMutexValue(key).currentlyRunning = null;
        setMutexValue(key, {
          ...getMutexValue(key),
          currentlyRunning:
            nextCb === undefined ? null : enqueueCallbackForMutex(key, nextCb),
        });
      }),
      waiting: [],
    });
  } else {
    setMutexValue(key, {
      ...mutex,
      waiting: [...mutex.waiting, callback],
    });
  }
}

async function manualMutex<T>(
  key: string,
  callback: () => Promise<T>,
): Promise<T> {
  const outerPromise = new Promise<T>((resolve, reject) => {
    const wrappedCallback: () => Promise<void> = () => {
      return callback()
        .then((v) => resolve(v))
        .catch((e) => reject(e));
    };
    void enqueueCallbackForMutex(key, wrappedCallback);
  });
  return outerPromise;
}

export const setupConvexClient = (
  convexUrl: string,
  options?: ConvexClientOptions,
) => {
  // Client resolution priority:
  // 1. Client from context
  // 2. Try to create one if setupConvex is available

  let client: ConvexClient | null = null;

  // Try to get client from context
  try {
    client = getContext("$$_convexClient");
  } catch (e) {
    // Context not available or no client in context
  }

  // If no client and convexUrl is provided, try to create one using setupConvex
  if (!client) {
    try {
      setupConvex(convexUrl, options);
      // After setting up, try to get the client from context
      try {
        client = getContext("$$_convexClient");
      } catch (e) {
        // Context not available after setup
      }
    } catch (e) {
      console.warn("Failed to create Convex client:", e);
    }
  }

  // If we still don't have a client, throw an error
  if (!client) {
    throw new Error(
      "No ConvexClient was provided. Either pass one to setupConvexAuth or call setupConvex() first.",
    );
  }

  return client;
};
