import { Value } from "convex/values";
import {
  ReactNode,
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import type {
  SignInAction,
  SignOutAction,
} from "../server/implementation/index.js";
import { AuthClient } from "./clientType.js";
import type {
  ConvexAuthActionsContext as ConvexAuthActionsContextType,
  TokenStorage,
} from "./index.js";
import isNetworkError from "is-network-error";

// Retry after this much time, based on the retry number.
const RETRY_BACKOFF = [500, 2000]; // In ms
const RETRY_JITTER = 100; // In ms

export const ConvexAuthActionsContext =
  createContext<ConvexAuthActionsContextType>(undefined as any);

const ConvexAuthInternalContext = createContext<{
  isLoading: boolean;
  isAuthenticated: boolean;
  fetchAccessToken: ({
    forceRefreshToken,
  }: {
    forceRefreshToken: boolean;
  }) => Promise<string | null>;
}>(undefined as any);

export function useAuth() {
  return useContext(ConvexAuthInternalContext);
}

export const ConvexAuthTokenContext = createContext<string | null>(null);

const VERIFIER_STORAGE_KEY = "__convexAuthOAuthVerifier";
const JWT_STORAGE_KEY = "__convexAuthJWT";
const REFRESH_TOKEN_STORAGE_KEY = "__convexAuthRefreshToken";
const SERVER_STATE_FETCH_TIME_STORAGE_KEY = "__convexAuthServerStateFetchTime";

export function AuthProvider({
  client,
  serverState,
  onChange,
  shouldHandleCode,
  storage,
  storageNamespace,
  replaceURL,
  children,
}: {
  client: AuthClient;
  serverState?: {
    _state: { token: string | null; refreshToken: string | null };
    _timeFetched: number;
  };
  onChange?: () => Promise<unknown>;
  shouldHandleCode?: (() => boolean) | boolean;
  storage: TokenStorage | null;
  storageNamespace: string;
  replaceURL: (relativeUrl: string) => void | Promise<void>;
  children: ReactNode;
}) {
  const token = useRef<string | null>(serverState?._state.token ?? null);
  const [isLoading, setIsLoading] = useState(token.current === null);
  const [tokenState, setTokenState] = useState<string | null>(token.current);

  const verbose: boolean = client.verbose ?? false;
  const logVerbose = useCallback(
    (message: string) => {
      if (verbose) {
        console.debug(`${new Date().toISOString()} ${message}`);
        client.logger?.logVerbose(message);
      }
    },
    [verbose],
  );
  const { storageSet, storageGet, storageRemove, storageKey } =
    useNamespacedStorage(storage, storageNamespace);

  const [isRefreshingToken, setIsRefreshingToken] = useState(false);
  const setToken = useCallback(
    async (
      args:
        | { shouldStore: true; tokens: { token: string; refreshToken: string } }
        | { shouldStore: false; tokens: { token: string } }
        | { shouldStore: boolean; tokens: null },
    ) => {
      const wasAuthenticated = token.current !== null;
      let newToken: string | null;
      if (args.tokens === null) {
        token.current = null;
        if (args.shouldStore) {
          await storageRemove(JWT_STORAGE_KEY);
          await storageRemove(REFRESH_TOKEN_STORAGE_KEY);
        }
        newToken = null;
      } else {
        const { token: value } = args.tokens;
        token.current = value;
        if (args.shouldStore) {
          const { refreshToken } = args.tokens;
          await storageSet(JWT_STORAGE_KEY, value);
          await storageSet(REFRESH_TOKEN_STORAGE_KEY, refreshToken);
        }
        newToken = value;
      }
      if (wasAuthenticated !== (newToken !== null)) {
        await onChange?.();
      }
      setTokenState(newToken);
      setIsLoading(false);
    },
    [storageSet, storageRemove],
  );

  useEffect(() => {
    const listener = async (e: Event) => {
      if (isRefreshingToken) {
        // There are 3 different ways to trigger this pop up so just try all of
        // them.

        e.preventDefault();
        // This confirmation message doesn't actually appear in most modern
        // browsers but we tried.
        const confirmationMessage =
          "Are you sure you want to leave? Your changes may not be saved.";
        e.returnValue = true;
        return confirmationMessage;
      }
    };
    browserAddEventListener("beforeunload", listener);
    return () => {
      browserRemoveEventListener("beforeunload", listener);
    };
  });

  useEffect(() => {
    // We're listening for:
    // 1. sibling tabs in case of localStorage
    // 2. other frames in case of sessionStorage
    const listener = (event: StorageEvent) => {
      void (async () => {
        // TODO: Test this if statement works in iframes correctly
        if (event.storageArea !== storage) {
          return;
        }
        // Another tab/frame set the access token, use it
        if (event.key === storageKey(JWT_STORAGE_KEY)) {
          const value = event.newValue;
          logVerbose(`synced access token, is null: ${value === null}`);
          // We don't write into storage since the event came from there and
          // we'd trigger a loop, plus we get each key as a separate event so
          // we don't have the refresh key here.
          await setToken({
            shouldStore: false,
            tokens: value === null ? null : { token: value },
          });
        }
      })();
    };
    browserAddEventListener("storage", listener);
    return () => browserRemoveEventListener("storage", listener);
  }, [setToken]);

  const verifyCode = useCallback(
    async (
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
    },
    [client],
  );

  const verifyCodeAndSetToken = useCallback(
    async (
      args: { code: string; verifier?: string } | { refreshToken: string },
    ) => {
      const { tokens } = await verifyCode(args);
      logVerbose(`retrieved tokens, is null: ${tokens === null}`);
      await setToken({ shouldStore: true, tokens: tokens ?? null });
      return tokens !== null;
    },
    [client, setToken],
  );

  const signIn = useCallback(
    async (provider?: string, args?: FormData | Record<string, Value>) => {
      const params =
        args instanceof FormData
          ? Array.from(args.entries()).reduce(
              (acc, [key, value]) => {
                acc[key] = value as string;
                return acc;
              },
              {} as Record<string, string>,
            )
          : args ?? {};

      const verifier = (await storageGet(VERIFIER_STORAGE_KEY)) ?? undefined;
      await storageRemove(VERIFIER_STORAGE_KEY);
      const result = await client.authenticatedCall(
        "auth:signIn" as unknown as SignInAction,
        { provider, params, verifier },
      );
      if (result.redirect !== undefined) {
        const url = new URL(result.redirect);
        await storageSet(VERIFIER_STORAGE_KEY, result.verifier!);
        // Do not redirect in React Native
        // Using a deprecated property because it's the only explicit check
        // available, and they set it explicitly and intentionally for this
        // purpose.
        if (navigator.product !== "ReactNative") {
          window.location.href = url.toString();
        }
        return { signingIn: false, redirect: url };
      } else if (result.tokens !== undefined) {
        const { tokens } = result;
        logVerbose(`signed in and got tokens, is null: ${tokens === null}`);
        await setToken({ shouldStore: true, tokens });
        return { signingIn: result.tokens !== null };
      }
      return { signingIn: false };
    },
    [client, setToken, storageGet],
  );

  const signOut = useCallback(async () => {
    try {
      await client.authenticatedCall(
        "auth:signOut" as unknown as SignOutAction,
      );
    } catch (error) {
      // Ignore any errors, they are usually caused by being
      // already signed out, which is ok.
    }
    logVerbose(`signed out, erasing tokens`);
    await setToken({ shouldStore: true, tokens: null });
  }, [setToken, client]);

  const fetchAccessToken = useCallback(
    async ({ forceRefreshToken }: { forceRefreshToken: boolean }) => {
      if (forceRefreshToken) {
        const tokenBeforeLockAquisition = token.current;
        return await browserMutex(REFRESH_TOKEN_STORAGE_KEY, async () => {
          const tokenAfterLockAquisition = token.current;
          // Another tab or frame just refreshed the token, we can use it
          // and skip another refresh.
          if (tokenAfterLockAquisition !== tokenBeforeLockAquisition) {
            logVerbose(
              `returning synced token, is null: ${tokenAfterLockAquisition === null}`,
            );
            return tokenAfterLockAquisition;
          }
          const refreshToken =
            (await storageGet(REFRESH_TOKEN_STORAGE_KEY)) ?? null;
          if (refreshToken !== null) {
            setIsRefreshingToken(true);
            await verifyCodeAndSetToken({ refreshToken }).finally(() => {
              setIsRefreshingToken(false);
            });
            logVerbose(
              `returning retrieved token, is null: ${tokenAfterLockAquisition === null}`,
            );
            return token.current;
          } else {
            setIsRefreshingToken(false);
            logVerbose(`returning null, there is no refresh token`);
            return null;
          }
        });
      }
      return token.current;
    },
    [verifyCodeAndSetToken, signOut, storageGet],
  );
  const signingInWithCodeFromURL = useRef<boolean>(false);
  useEffect(
    () => {
      // Has to happen in useEffect to avoid SSR.
      if (storage === undefined) {
        throw new Error(
          "`localStorage` is not available in this environment, " +
            "set the `storage` prop on `ConvexAuthProvider`!",
        );
      }
      const readStateFromStorage = async () => {
        const token = (await storageGet(JWT_STORAGE_KEY)) ?? null;
        logVerbose(`retrieved token from storage, is null: ${token === null}`);
        await setToken({
          shouldStore: false,
          tokens: token === null ? null : { token },
        });
      };

      if (serverState !== undefined) {
        // First check that this isn't a subsequent render
        // with stale serverState.
        const timeFetched = storageGet(SERVER_STATE_FETCH_TIME_STORAGE_KEY);
        const setTokensFromServerState = (
          timeFetched: string | null | undefined,
        ) => {
          if (!timeFetched || serverState._timeFetched > +timeFetched) {
            const { token, refreshToken } = serverState._state;
            const tokens =
              token === null || refreshToken === null
                ? null
                : { token, refreshToken };
            void storageSet(
              SERVER_STATE_FETCH_TIME_STORAGE_KEY,
              serverState._timeFetched.toString(),
            );
            void setToken({ tokens, shouldStore: true });
          } else {
            void readStateFromStorage();
          }
        };

        // We want to avoid async if possible.
        if (timeFetched instanceof Promise) {
          void timeFetched.then(setTokensFromServerState);
        } else {
          setTokensFromServerState(timeFetched);
        }

        return;
      }
      const code =
        typeof window?.location?.search !== "undefined"
          ? new URLSearchParams(window.location.search).get("code")
          : null;
      // code from URL is only consumed initially,
      // ref avoids racing in Strict mode
      if (
        (signingInWithCodeFromURL.current || code) &&
        !signingInWithCodeFromURL.current &&
        (shouldHandleCode === undefined ||
          (typeof shouldHandleCode === "function"
            ? shouldHandleCode()
            : shouldHandleCode))
      ) {
        signingInWithCodeFromURL.current = true;
        const url = new URL(window.location.href);
        url.searchParams.delete("code");
        void (async () => {
          await replaceURL(url.pathname + url.search + url.hash);
          await signIn(undefined, { code });
          signingInWithCodeFromURL.current = false;
        })();
      } else {
        void readStateFromStorage();
      }
    },
    // Explicitly chosen dependencies.
    // This effect should mostly only run once
    // on mount.
    [client, storageGet],
  );

  const actions = useMemo(() => ({ signIn, signOut }), [signIn, signOut]);
  const isAuthenticated = tokenState !== null;
  const authState = useMemo(
    () => ({
      isLoading,
      isAuthenticated,
      fetchAccessToken,
    }),
    [fetchAccessToken, isLoading, isAuthenticated],
  );

  return (
    <ConvexAuthInternalContext.Provider value={authState}>
      <ConvexAuthActionsContext.Provider value={actions}>
        <ConvexAuthTokenContext.Provider value={tokenState}>
          {children}
        </ConvexAuthTokenContext.Provider>
      </ConvexAuthActionsContext.Provider>
    </ConvexAuthInternalContext.Provider>
  );
}

function useNamespacedStorage(
  peristentStorage: TokenStorage | null,
  namespace: string,
) {
  const inMemoryStorage = useInMemoryStorage();
  const storage = useMemo(
    () => peristentStorage ?? inMemoryStorage(),
    [peristentStorage],
  );
  const escapedNamespace = namespace.replace(/[^a-zA-Z0-9]/g, "");
  const storageKey = useCallback(
    (key: string) => `${key}_${escapedNamespace}`,
    [namespace],
  );
  const storageSet = useCallback(
    (key: string, value: string) => storage.setItem(storageKey(key), value),
    [storage, storageKey],
  );
  const storageGet = useCallback(
    (key: string) => storage.getItem(storageKey(key)),
    [storage, storageKey],
  );
  const storageRemove = useCallback(
    (key: string) => storage.removeItem(storageKey(key)),
    [storage, storageKey],
  );
  return { storageSet, storageGet, storageRemove, storageKey };
}

function useInMemoryStorage() {
  const [inMemoryStorage, setInMemoryStorage] = useState<
    Record<string, string>
  >({});
  return () =>
    ({
      getItem: (key) => inMemoryStorage[key],
      setItem: (key, value) => {
        setInMemoryStorage((prev) => ({ ...prev, [key]: value }));
      },
      removeItem: (key) => {
        setInMemoryStorage((prev) => {
          const { [key]: _, ...rest } = prev;
          return rest;
        });
      },
    }) satisfies TokenStorage;
}

// In the browser, executes the callback as the only tab / frame at a time.
async function browserMutex<T>(
  key: string,
  callback: () => Promise<T>,
): Promise<T> {
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

function browserAddEventListener<K extends keyof WindowEventMap>(
  type: K,
  listener: (this: Window, ev: WindowEventMap[K]) => any,
  options?: boolean | AddEventListenerOptions,
): void {
  window.addEventListener?.(type, listener, options);
}

function browserRemoveEventListener<K extends keyof WindowEventMap>(
  type: K,
  listener: (this: Window, ev: WindowEventMap[K]) => any,
  options?: boolean | EventListenerOptions,
): void {
  window.removeEventListener?.(type, listener, options);
}
