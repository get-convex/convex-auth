/**
 * Next.js (App Router) client bindings for Convex Auth, exported at
 * `@convex-dev/auth/nextjs`.
 *
 * {@link ConvexAuthNextjsProvider} is the client-side counterpart to the server
 * bindings. Unlike the plain React provider, the browser never holds the
 * refresh token — it lives in an httpOnly cookie. So this provider:
 *
 * - keeps tokens in memory only (no `localStorage`);
 * - hydrates from the `initialToken` the server provider passes down, so the
 *   app renders authenticated without a round-trip;
 * - refreshes and signs out by POSTing to the route handler (which reads the
 *   httpOnly cookie), never by calling Convex with a refresh token;
 * - moves a provider sign-in's `TokenBundle` into the httpOnly cookie via the
 *   same endpoint (its `setSession`), keeping only the access token client-side.
 *
 * It reuses the framework-agnostic {@link AuthClient} and the React
 * `AuthProvider`, so provider hooks (`useAnonymousAuth`, …) and
 * `useAuthToken`/`useAuthActions` work exactly as with the plain React binding.
 *
 * @module
 */
"use client";

import { ConvexProviderWithAuth, ConvexReactClient } from "convex/react";
import { ReactNode, useMemo } from "react";
import { AuthClient } from "../browser/sessionManager";
import {
  InMemoryStorage,
  JWT_STORAGE_KEY,
  NamespacedStorage,
  REFRESH_TOKEN_STORAGE_KEY,
  TokenStorage,
} from "../browser/storage";
import type { TokenBundle } from "../lib/types";
import {
  AuthProvider,
  ConvexAuthActionsContextType,
  useAuth,
} from "../react/client";

export { useConvexAuth } from "convex/react";
export { Authenticated, Unauthenticated, AuthLoading } from "convex/react";
export { useAuthActions, useAuthToken } from "../react";

/**
 * The refresh-token slot's value on the client. The real refresh token is in an
 * httpOnly cookie the browser can't read; this marker just tells the
 * {@link AuthClient} a session exists so it will attempt a refresh (which POSTs
 * to the route handler). The server endpoint is the source of truth — an
 * expired cookie yields no tokens and the client clears.
 */
const SESSION_PRESENT_MARKER = "__convexAuthSessionPresent";

/** The access-token-only payload the route handler returns. */
type PublicTokens = {
  accessToken: string;
  accessTokenExpiresAt: number;
  userId: string;
} | null;

/** Map the endpoint's access-token payload to a bundle with a marker refresh token. */
function toBundle(tokens: NonNullable<PublicTokens>): TokenBundle {
  return {
    accessToken: tokens.accessToken,
    accessTokenExpiresAt: tokens.accessTokenExpiresAt,
    refreshToken: SESSION_PRESENT_MARKER,
    refreshTokenExpiresAt: 0,
    userId: tokens.userId,
  };
}

async function postAuth(
  apiRoute: string,
  body: Record<string, unknown>,
): Promise<PublicTokens> {
  const res = await fetch(apiRoute, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!res.ok) return null;
  const json = (await res.json().catch(() => ({}))) as {
    tokens?: PublicTokens;
  };
  return json.tokens ?? null;
}

/**
 * Replace your `ConvexProvider` with this (rendered by
 * `ConvexAuthNextjsServerProvider`, which supplies `initialToken`).
 *
 * ```tsx
 * // app/layout.tsx
 * import { ConvexAuthNextjsServerProvider } from "./convexAuthServer";
 *
 * export default function RootLayout({ children }) {
 *   return (
 *     <html><body>
 *       <ConvexAuthNextjsServerProvider>{children}</ConvexAuthNextjsServerProvider>
 *     </body></html>
 *   );
 * }
 * ```
 */
export function ConvexAuthNextjsProvider({
  client,
  convexUrl,
  apiRoute = "/api/auth",
  initialToken = null,
  storage,
  children,
}: {
  /** An existing `ConvexReactClient`. Defaults to one built from `convexUrl`. */
  client?: ConvexReactClient;
  /** Convex deployment URL. Defaults to `process.env.NEXT_PUBLIC_CONVEX_URL`. */
  convexUrl?: string;
  /** Path of the auth route handler. Defaults to `"/api/auth"`. */
  apiRoute?: string;
  /** The server-provided access token used to hydrate the client. */
  initialToken?: string | null;
  /** Override in-memory storage (rarely needed). */
  storage?: TokenStorage;
  children: ReactNode;
}) {
  const convex = useMemo(
    () =>
      client ??
      new ConvexReactClient(
        convexUrl ?? (process.env.NEXT_PUBLIC_CONVEX_URL as string),
      ),
    [client, convexUrl],
  );

  const authClient = useMemo(() => {
    const tokenStorage = storage ?? new InMemoryStorage();
    const namespace = convex.url;
    // Seed the in-memory store so init() reports authenticated immediately,
    // with the marker standing in for the (httpOnly, server-only) refresh token.
    if (initialToken) {
      const seeded = new NamespacedStorage(tokenStorage, namespace);
      void seeded.set(JWT_STORAGE_KEY, initialToken);
      void seeded.set(REFRESH_TOKEN_STORAGE_KEY, SESSION_PRESENT_MARKER);
    }
    return new AuthClient({
      authApi: {
        // The refresh token argument is the marker; the endpoint reads the
        // real one from the httpOnly cookie.
        refreshSession: async () => {
          const tokens = await postAuth(apiRoute, { action: "refresh" });
          return tokens ? toBundle(tokens) : null;
        },
        signOut: async () => {
          await postAuth(apiRoute, { action: "signOut" });
        },
      },
      storage: tokenStorage,
      storageNamespace: namespace,
    });
    // `convex` identity is what matters; the other props are read once at
    // construction (mirrors the plain React provider).
  }, [convex]);

  const actions = useMemo<ConvexAuthActionsContextType>(
    () => ({
      // A provider sign-in returns a full bundle (with a real refresh token).
      // Push it to the server so the refresh token is stashed httpOnly, and
      // keep only the access token (+ marker) in the browser.
      setSession: async (bundle: TokenBundle) => {
        const tokens = await postAuth(apiRoute, {
          action: "setSession",
          bundle,
        });
        if (tokens) await authClient.setSession(toBundle(tokens));
      },
      // `authClient.signOut` calls the marker-based `authApi.signOut`, which
      // POSTs to the endpoint to clear the httpOnly cookies.
      signOut: authClient.signOut,
    }),
    [authClient, apiRoute],
  );

  return (
    <AuthProvider authClient={authClient} actions={actions}>
      <ConvexProviderWithAuth client={convex} useAuth={useAuth}>
        {children}
      </ConvexProviderWithAuth>
    </AuthProvider>
  );
}
