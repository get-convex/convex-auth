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
import type { SignInAction, SignOutAction } from "../server/implementation";
import { AuthClient } from "./clientType";
import type {
  ConvexAuthActionsContext as ConvexAuthActionsContextType,
  TokenStorage,
} from "./index";

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

function useConvexAuthInternalContext() {
  return useContext(ConvexAuthInternalContext);
}

const VERIFIER_STORAGE_KEY = "__convexAuthOAuthVerifier";
const JWT_STORAGE_KEY = "__convexAuthJWT";
const REFRESH_TOKEN_STORAGE_KEY = "__convexAuthRefreshToken";
const SERVER_STATE_FETCH_TIME_STORAGE_KEY = "__convexAuthServerStateFetchTime";

export function AuthProvider({
  client,
  serverState,
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
  storage: TokenStorage | null;
  storageNamespace: string;
  replaceURL: (relativeUrl: string) => void | Promise<void>;
  children: ReactNode;
}) {
  const token = useRef<string | null>(serverState?._state.token ?? null);
  const [isLoading, setIsLoading] = useState(token.current === null);
  const [isAuthenticated, setIsAuthenticated] = useState(
    token.current !== null,
  );

  const verbose: boolean = (client as any).options?.verbose;
  const logVerbose = useCallback(
    (message: string) => {
      if (verbose) {
        console.debug(`${new Date().toISOString()} ${message}`);
      }
    },
    [verbose],
  );
  const { storageSet, storageGet, storageRemove, storageKey } =
    useNamespacedStorage(storage, storageNamespace);
  const setToken = useCallback(
    async (
      args:
        | { shouldStore: true; tokens: { token: string; refreshToken: string } }
        | { shouldStore: false; tokens: { token: string } }
        | { shouldStore: boolean; tokens: null },
    ) => {
      if (args.tokens === null) {
        token.current = null;
        if (args.shouldStore) {
          await storageRemove(JWT_STORAGE_KEY);
          await storageRemove(REFRESH_TOKEN_STORAGE_KEY);
        }
        setIsAuthenticated(false);
      } else {
        const { token: value } = args.tokens;
        token.current = value;
        if (args.shouldStore) {
          const { refreshToken } = args.tokens;
          await storageSet(JWT_STORAGE_KEY, value);
          await storageSet(REFRESH_TOKEN_STORAGE_KEY, refreshToken);
        }
        setIsAuthenticated(true);
      }
      setIsLoading(false);
    },
    [storageSet, storageRemove],
  );

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

  const verifyCodeAndSetToken = useCallback(
    async (
      args: { code: string; verifier?: string } | { refreshToken: string },
    ) => {
      const { tokens } = await client.unauthenticatedCall(
        "auth:signIn" as unknown as SignInAction,
        "code" in args
          ? { params: { code: args.code }, verifier: args.verifier }
          : args,
      );
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
        await storageSet(VERIFIER_STORAGE_KEY, result.verifier);
        // Do not redirect in React Native
        if (window.location !== undefined) {
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
    // We can't wait for this action to finish,
    // because it never will if we are already signed out.
    void client.authenticatedCall("auth:signOut" as unknown as SignOutAction);
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
            await storageRemove(REFRESH_TOKEN_STORAGE_KEY);
            const beforeUnloadHandler = (event: BeforeUnloadEvent) => {
              event.preventDefault();
              event.returnValue = true;
            };
            browserAddEventListener("beforeunload", beforeUnloadHandler);
            await verifyCodeAndSetToken({ refreshToken });
            browserRemoveEventListener("beforeunload", beforeUnloadHandler);
            logVerbose(
              `returning retrieved token, is null: ${tokenAfterLockAquisition === null}`,
            );
            return token.current;
          } else {
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
  useEffect(() => {
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
      typeof window?.location !== "undefined"
        ? new URLSearchParams(window.location.search).get("code")
        : null;
    // code from URL is only consumed initially,
    // ref avoids racing in Strict mode
    if (signingInWithCodeFromURL.current || code) {
      if (code) {
        signingInWithCodeFromURL.current = true;
        const url = new URL(window.location.href);
        url.searchParams.delete("code");
        void (async () => {
          await replaceURL(url.pathname + url.search + url.hash);
          await signIn(undefined, { code });
          signingInWithCodeFromURL.current = false;
        })();
      }
    } else {
      void readStateFromStorage();
    }
  }, [client, setToken, signIn, storageGet]);

  return (
    <ConvexAuthInternalContext.Provider
      value={{
        isLoading,
        isAuthenticated,
        fetchAccessToken,
      }}
    >
      <ConvexAuthActionsContext.Provider value={{ signIn, signOut }}>
        {children}
      </ConvexAuthActionsContext.Provider>
    </ConvexAuthInternalContext.Provider>
  );
}

function useNamespacedStorage(
  peristentStorage: TokenStorage | null,
  namespace: string,
) {
  const inMemoryStorage = useInMemoryStorage();
  const storage = peristentStorage ?? inMemoryStorage();
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

export function useAuth() {
  const { isLoading, isAuthenticated, fetchAccessToken } =
    useConvexAuthInternalContext();
  return useMemo(
    () => ({
      isLoading,
      isAuthenticated,
      fetchAccessToken,
    }),
    [fetchAccessToken, isLoading, isAuthenticated],
  );
}

// In the browser, executes the callback as the only tab / frame at a time.
async function browserMutex<T>(
  key: string,
  callback: () => Promise<T>,
): Promise<T> {
  const lockManager = window?.navigator?.locks;
  return lockManager !== undefined
    ? await lockManager.request(key, callback)
    : await callback();
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
