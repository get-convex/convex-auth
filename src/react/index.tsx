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
import type {
  SignInAction,
  SignOutAction,
  VerifyCodeAction,
} from "../server/implementation";

/**
 * Use this hook to access the `signIn`, `verifyCode` and `signOut` methods:
 *
 * ```ts
 * import { useAuthActions } from "@xixixao/convex-auth/react";
 *
 * function SomeComponent() {
 *   const { signIn, verifyCode, signOut } = useAuthActions();
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
   * @param args Either a `FormData` object containing the sign-in
   *        parameters or a plain object containing them.
   * @returns Whether the user was immediately signed in (ie. the sign-in
   *          didn't trigger an additional step like email verification
   *          or OAuth signin).
   */
  signIn: (
    provider: string,
    args?: FormData | Record<string, Value>,
  ) => Promise<boolean>;

  /**
   * Complete signin with a verification code via one of your configured
   * authentication providers.
   *
   * @param provider The ID of the provider (lowercase version of the
   *        provider name or a configured `id` option value).
   * @param args Either a `FormData` object containing the sign-in
   *        parameters or a plain object containing them.
   *        The `code` field is required.
   * @returns Whether the user was successfully signed in.
   */
  verifyCode: (
    provider: string,
    args: FormData | { code: string; [key: string]: Value },
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
  children,
}: {
  client: ConvexReactClient;
  storage: TokenStorage;
  children: ReactNode;
}) {
  const token = useRef<string | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [isAuthenticated, setIsAuthenticated] = useState(false);

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
          await storage.removeItem(JWT_STORAGE_KEY);
          await storage.removeItem(REFRESH_TOKEN_STORAGE_KEY);
        }
        setIsAuthenticated(false);
      } else {
        const { token: value } = args.tokens;
        token.current = value;
        if (args.shouldStore) {
          const { refreshToken } = args.tokens;
          await storage.setItem(JWT_STORAGE_KEY, value);
          await storage.setItem(REFRESH_TOKEN_STORAGE_KEY, refreshToken);
        }
        setIsAuthenticated(true);
      }
      setIsLoading(false);
    },
    [],
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

        // Another document set the access token, use it
        if (event.key === JWT_STORAGE_KEY) {
          const value = event.newValue;
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
    window.addEventListener?.("storage", listener);
    return () => window.removeEventListener?.("storage", listener);
  }, []);

  const verifyCodeAndSetToken = useCallback(
    async (args: {
      params: Record<string, Value>;
      verifier?: string;
      provider?: string;
      refreshToken?: string;
    }) => {
      const tokens = await new ConvexHttpClient((client as any).address).action(
        "auth:verifyCode" as unknown as VerifyCodeAction,
        args,
      );
      await setToken({ shouldStore: true, tokens });
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
        await storage.setItem(VERIFIER_STORAGE_KEY, verifier);
        window.location.href = `${result.redirect}?code=` + verifier;
        return false;
      } else if (result.tokens !== undefined) {
        await setToken({ shouldStore: true, tokens: result.tokens });
        return result.tokens !== null;
      }
      return false;
    },
    [client, setToken],
  );

  const verifyCode = useCallback(
    async (
      provider: string,
      args: FormData | { code: string; [key: string]: Value },
    ) => {
      const params =
        args instanceof FormData
          ? Array.from(args.entries()).reduce(
              (acc, [key, value]) => {
                acc[key] = value as string;
                return acc;
              },
              {} as Record<string, string>,
            )
          : args;
      return await verifyCodeAndSetToken({ provider, params });
    },
    [verifyCodeAndSetToken],
  );

  const signOut = useCallback(async () => {
    // We can't wait for this action to finish,
    // because it never will if we are already signed out.
    void client.action("auth:signOut" as unknown as SignOutAction);
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
            return tokenAfterLockAquisition;
          }
          const refreshToken = await storage.getItem(REFRESH_TOKEN_STORAGE_KEY);
          if (refreshToken !== null) {
            await storage.removeItem(REFRESH_TOKEN_STORAGE_KEY);
            await verifyCodeAndSetToken({ params: {}, refreshToken });
            return token.current;
          } else {
            return null;
          }
        });
      }
      return token.current;
    },
    [verifyCodeAndSetToken, signOut],
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
        const verifier =
          (await getAndRemove(storage, VERIFIER_STORAGE_KEY)) ?? undefined;
        void verifyCodeAndSetToken({ params: { code }, verifier });
        const url = new URL(window.location.href);
        url.searchParams.delete("code");
        window.history.replaceState({}, "", url.toString());
      } else {
        const token = (await storage.getItem(JWT_STORAGE_KEY)) ?? null;
        await setToken({
          shouldStore: false,
          tokens: token === null ? null : { token },
        });
      }
    })();
  }, [client, setToken, verifyCodeAndSetToken]);

  return (
    <ConvexAuthInternalContext.Provider
      value={{
        isLoading,
        isAuthenticated,
        fetchAccessToken,
      }}
    >
      <ConvexAuthActionsContext.Provider
        value={{
          verifyCode,
          signIn,
          signOut,
        }}
      >
        {children}
      </ConvexAuthActionsContext.Provider>
    </ConvexAuthInternalContext.Provider>
  );
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

// This is not atomic, and cannot be relied upon to be atomic.
async function getAndRemove(storage: TokenStorage, key: string) {
  const value = await storage.getItem(key);
  await storage.removeItem(key);
  return value;
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
