"use client";

import { ConvexProviderWithAuth, ConvexReactClient } from "convex/react";
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

const ClientAuthContext = createContext<{
  isLoading: boolean;
  isAuthenticated: boolean;
  token: string | null;
  fetchAccessToken: ({
    forceRefreshToken,
  }: {
    forceRefreshToken: boolean;
  }) => Promise<string | null>;
  signIn: (
    provider: string,
    args?: FormData | Record<string, string>,
  ) => Promise<void>;
  verifyCode: (
    provider: string,
    args: FormData | { code: string },
  ) => Promise<void>;
  signOut: () => Promise<void>;
}>(undefined as any);

export function useConvexAuthClient() {
  return useContext(ClientAuthContext);
}

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
      params: Record<string, string | undefined>;
      verifier?: string;
      provider?: string;
      refreshToken?: string;
    }) => {
      const response = await fetch(
        getSiteUrl(client) + `/api/auth/verifyCode`,
        {
          method: "POST",
          body: JSON.stringify(args),
          headers: {
            "Content-Type": "application/json",
          },
        },
      );
      const tokens = await response.json();
      setToken(tokens);
    },
    [client, setToken],
  );

  const signIn = useCallback(
    async (providerId: string, args?: FormData | Record<string, string>) => {
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

      const result = await client.action("auth:signIn" as any, {
        provider: providerId,
        params,
      });
      if (result.redirect === true) {
        const verifier = crypto.randomUUID();
        window.localStorage.setItem(VERIFIER_STORAGE_KEY, verifier);
        window.location.href =
          getSiteUrl(client) +
          `/api/auth/signin/${providerId}?code=` +
          verifier;
      } else if (result.tokens !== undefined) {
        setToken(result.tokens);
      }
    },
    [client, setToken],
  );

  const verifyCode = useCallback(
    async (provider: string, args: FormData | { code: string }) => {
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
    await client.action("auth:signOut" as any);
    setToken(null);
  }, [setToken, client]);

  return (
    <ClientAuthContext.Provider
      value={{
        isLoading,
        isAuthenticated,
        token: token.current,
        fetchAccessToken,
        verifyCode,
        signIn,
        signOut,
      }}
    >
      {children}
    </ClientAuthContext.Provider>
  );
}

export function useAuth() {
  const { isLoading, isAuthenticated, fetchAccessToken } =
    useConvexAuthClient();
  return useMemo(
    () => ({
      isLoading,
      isAuthenticated,
      fetchAccessToken,
    }),
    [fetchAccessToken, isLoading, isAuthenticated],
  );
}

function getSiteUrl(client: ConvexReactClient) {
  return (client as any).address.replace(/.cloud$/, ".site");
}
