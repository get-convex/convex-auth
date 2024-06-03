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
 * The result of calling `useConvexAuthClient`.
 */
export type ConvexAuthClientContext = {
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
   * Deletes locally stored JWT and refresh token,
   * and calls the server to invalidate the server session.
   */
  signOut: () => Promise<void>;
};

const ConvexAuthClientContext = createContext<ConvexAuthClientContext>(
  undefined as any,
);

/**
 * Use this hook to access the `signIn`, `verifyCode` and `signOut` methods:
 *
 * ```ts
 * function SomeComponent() {
 *   const { signIn, verifyCode, signOut } = useConvexAuthClient();
 *   // ...
 * }
 * ```
 */
export function useConvexAuthClient() {
  return useContext(ConvexAuthClientContext);
}

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

/**
 * Replace your `ConvexProvider` with this component to enable authentication.
 *
 * @param props - an object with a `client` property that refers to a {@link ConvexReactClient}.
 */
export function ConvexAuthProvider({
  client,
  children,
}: {
  client: ConvexReactClient;
  children: ReactNode;
}) {
  return (
    <AuthProvider client={client}>
      <ConvexProviderWithAuth client={client} useAuth={useAuth}>
        {children}
      </ConvexProviderWithAuth>
    </AuthProvider>
  );
}

const VERIFIER_STORAGE_KEY = "__convexAuthOAuthVerifier";
const JWT_STORAGE_KEY = "__convexAuthJWT";
const REFRESH_TOKEN_STORAGE_KEY = "__convexAuthRefreshToken";

function AuthProvider({
  client,
  children,
}: {
  client: ConvexReactClient;
  children: ReactNode;
}) {
  const token = useRef<string | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [isAuthenticated, setIsAuthenticated] = useState(false);

  const setToken = useCallback(
    (tokens: { token: string; refreshToken: string } | null) => {
      if (tokens === null) {
        token.current = null;
        window.localStorage.removeItem(JWT_STORAGE_KEY);
        window.localStorage.removeItem(REFRESH_TOKEN_STORAGE_KEY);
        setIsAuthenticated(false);
      } else {
        const { token: value, refreshToken } = tokens;
        token.current = value;
        window.localStorage.setItem(JWT_STORAGE_KEY, value);
        window.localStorage.setItem(REFRESH_TOKEN_STORAGE_KEY, refreshToken);
        setIsAuthenticated(true);
      }
      setIsLoading(false);
    },
    [],
  );

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
      setToken(tokens);
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
        window.localStorage.setItem(VERIFIER_STORAGE_KEY, verifier);
        window.location.href = `${result.redirect}?code=` + verifier;
        return false;
      } else if (result.tokens !== undefined) {
        setToken(result.tokens);
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

  const fetchAccessToken = useCallback(
    async ({ forceRefreshToken }: { forceRefreshToken: boolean }) => {
      if (forceRefreshToken) {
        const refreshToken = window.localStorage.getItem(
          REFRESH_TOKEN_STORAGE_KEY,
        );
        window.localStorage.removeItem(REFRESH_TOKEN_STORAGE_KEY);
        if (refreshToken !== null) {
          await verifyCodeAndSetToken({ params: {}, refreshToken });
        } else {
          return null;
        }
      }
      return token.current;
    },
    [verifyCodeAndSetToken],
  );
  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const code = params.get("code");
    if (code) {
      const verifier =
        window.localStorage.getItem(VERIFIER_STORAGE_KEY) ?? undefined;
      window.localStorage.removeItem(VERIFIER_STORAGE_KEY);
      void verifyCodeAndSetToken({ params: { code }, verifier });
      const url = new URL(window.location.href);
      url.searchParams.delete("code");
      window.history.replaceState({}, "", url.toString());
    } else {
      const token = window.localStorage.getItem(JWT_STORAGE_KEY);
      const refreshToken = window.localStorage.getItem(
        REFRESH_TOKEN_STORAGE_KEY,
      );
      setToken(token && refreshToken ? { token, refreshToken } : null);
    }
  }, [client, setToken, verifyCodeAndSetToken]);

  const signOut = useCallback(async () => {
    await client.action("auth:signOut" as unknown as SignOutAction);
    setToken(null);
  }, [setToken, client]);

  return (
    <ConvexAuthInternalContext.Provider
      value={{
        isLoading,
        isAuthenticated,
        fetchAccessToken,
      }}
    >
      <ConvexAuthClientContext.Provider
        value={{
          verifyCode,
          signIn,
          signOut,
        }}
      >
        {children}
      </ConvexAuthClientContext.Provider>
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
