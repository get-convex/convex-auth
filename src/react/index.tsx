/**
 * React bindings for Convex Auth.
 *
 * @module
 */

"use client";

import { ConvexProviderWithAuth, ConvexReactClient } from "convex/react";
import { ConvexHttpClient } from "convex/browser";
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

/**
 * Use this hook to access the `signIn` and `signOut` methods:
 *
 * ```ts
 * import { useAuthActions } from "@xixixao/convex-auth/react";
 *
 * function SomeComponent() {
 *   const { signIn, signOut } = useAuthActions();
 *   // ...
 * }
 * ```
 */
export function useAuthActions() {
  return useContext(ConvexAuthActionsContext);
}

/**
 * Replace your `ConvexProvider` with this component to enable authentication.
 *
 * ```tsx
 * import { ConvexAuthProvider } from "@xixixao/convex-auth/react";
 * import { ConvexReactClient } from "convex/react";
 * import { ReactNode } from "react";
 *
 * const convex = new ConvexReactClient(/* ... *\/);
 *
 * function RootComponent({ children }: { children: ReactNode }) {
 *   return <ConvexAuthProvider client={convex}>{children}</ConvexAuthProvider>;
 * }
 * ```
 *
 * @param props
 */
export function ConvexAuthProvider({
  client,
  storage,
  storageNamespace,
  children,
}: {
  /**
   * Your [`ConvexReactClient`](https://docs.convex.dev/api/classes/react.ConvexReactClient).
   */
  client: ConvexReactClient;
  /**
   * Optional custom storage object that implements
   * the {@link TokenStorage} interface, otherwise
   * [`localStorage`](https://developer.mozilla.org/en-US/docs/Web/API/Window/localStorage)
   * is used.
   *
   * You must set this for React Native.
   */
  storage?: TokenStorage;
  /**
   * Optional namespace for keys used to store tokens. The keys
   * determine whether the tokens are shared or not.
   *
   * Defaults to the deployment URL, as configured in the given `client`.
   */
  storageNamespace?: string;
  /**
   * Children components can call Convex hooks
   * and {@link useAuthActions}.
   */
  children: ReactNode;
}) {
  return (
    <AuthProvider
      client={client}
      storage={
        storage ??
        // Handle SSR, RN, Web, etc.
        // Pretend we always have storage, the component checks
        // it in first useEffect.
        (typeof window === "undefined" ? undefined : window?.localStorage)!
      }
      storageNamespace={storageNamespace ?? (client as any).address}
    >
      <ConvexProviderWithAuth client={client} useAuth={useAuth}>
        {children}
      </ConvexProviderWithAuth>
    </AuthProvider>
  );
}

/**
 * A storage interface for storing and retrieving tokens and other secrets.
 *
 * In browsers `localStorage` and `sessionStorage` implement this interface.
 *
 * `sessionStorage` can be used for creating separate sessions for each
 * browser tab.
 *
 * In React Native we recommend wrapping `expo-secure-store`.
 */
export interface TokenStorage {
  /**
   * Read a value.
   * @param key Unique key.
   */
  getItem: (
    key: string,
  ) => string | undefined | null | Promise<string | undefined | null>;
  /**
   * Write a value.
   * @param key Unique key.
   * @param value The value to store.
   */
  setItem: (key: string, value: string) => void | Promise<void>;
  /**
   * Remove a value.
   * @param key Unique key.
   */
  removeItem: (key: string) => void | Promise<void>;
}

/**
 * The result of calling {@link useAuthActions}.
 */
export type ConvexAuthActionsContext = {
  /**
   * Sign in via one of your configured authentication providers.
   *
   * @param provider The ID of the provider (lowercase version of the
   *        provider name or a configured `id` option value).
   * @param params Either a `FormData` object containing the sign-in
   *        parameters or a plain object containing them.
   *        The shape required depends on the chosen provider's
   *        implementation.
   * @returns Whether the user was immediately signed in (ie. the sign-in
   *          didn't trigger an additional step like email verification
   *          or OAuth signin).
   */
  signIn: (
    provider: string,
    params?: FormData | Record<string, Value>,
  ) => Promise<boolean>;

  /**
   * Sign out the current user.
   *
   * Calls the server to invalidate the server session
   * and deletes the locally stored JWT and refresh token.
   */
  signOut: () => Promise<void>;
};

/// Implementation details below

const ConvexAuthActionsContext = createContext<ConvexAuthActionsContext>(
  undefined as any,
);

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

function AuthProvider({
  client,
  storage,
  storageNamespace,
  children,
}: {
  client: ConvexReactClient;
  storage: TokenStorage;
  storageNamespace: string;
  children: ReactNode;
}) {
  const token = useRef<string | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [isAuthenticated, setIsAuthenticated] = useState(false);
  const verbose: boolean = (client as any).options?.verbose;
  const logVerbose = useCallback(
    (message: string) => {
      if (verbose) {
        console.debug(`${new Date().toISOString()} ${message}`);
      }
    },
    [verbose],
  );
  const { storageSet, storageGet, storageRemove } = useNamespacedStorage(
    storage,
    storageNamespace,
  );
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
        if (event.key === JWT_STORAGE_KEY) {
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
      const { tokens } = await new ConvexHttpClient(
        (client as any).address,
      ).action(
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
    async (providerId: string, args?: FormData | Record<string, Value>) => {
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

      const result = await client.action(
        "auth:signIn" as unknown as SignInAction,
        {
          provider: providerId,
          params,
        },
      );
      if (result.redirect !== undefined) {
        const verifier = crypto.randomUUID();
        await storageSet(VERIFIER_STORAGE_KEY, verifier);
        window.location.href = `${result.redirect}?code=` + verifier;
        return false;
      } else if (result.tokens !== undefined) {
        const { tokens } = result;
        logVerbose(`signed in and got tokens, is null: ${tokens === null}`);
        await setToken({ shouldStore: true, tokens });
        return result.tokens !== null;
      }
      return false;
    },
    [client, setToken, storageGet],
  );

  const signOut = useCallback(async () => {
    // We can't wait for this action to finish,
    // because it never will if we are already signed out.
    void client.action("auth:signOut" as unknown as SignOutAction);
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
  useEffect(() => {
    // Has to happen in useEffect to avoid SSR.
    if (storage === undefined || storage === null) {
      throw new Error(
        "`localStorage` is not available in this environment, " +
          "set the `storage` prop on `ConvexAuthProvider`!",
      );
    }
    void (async () => {
      const code =
        typeof window?.location !== "undefined"
          ? new URLSearchParams(window.location.search).get("code")
          : null;
      if (code) {
        const verifier = (await storageGet(VERIFIER_STORAGE_KEY)) ?? undefined;
        await storageRemove(VERIFIER_STORAGE_KEY);
        await verifyCodeAndSetToken({ code, verifier });
        const url = new URL(window.location.href);
        url.searchParams.delete("code");
        window.history.replaceState({}, "", url.toString());
      } else {
        const token = (await storage.getItem(JWT_STORAGE_KEY)) ?? null;
        logVerbose(`retrieved token from storage, is null: ${token === null}`);
        await setToken({
          shouldStore: false,
          tokens: token === null ? null : { token },
        });
      }
    })();
  }, [client, setToken, verifyCodeAndSetToken, storageGet]);

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

function useNamespacedStorage(storage: TokenStorage, namespace: string) {
  const storageKey = useCallback(
    (key: string) => `${key}:${namespace}`,
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
  return { storageSet, storageGet, storageRemove };
}

function useAuth() {
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
