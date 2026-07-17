/**
 * Client bindings for Convex Auth on Next.js (App Router), exported at
 * `@convex-dev/auth/nextjs`.
 *
 * Under SSR the refresh token lives only in a server-only httpOnly cookie, so
 * the browser holds *just* the access token. {@link ConvexAuthNextjsProvider}
 * configures the core {@link AuthClient} in that delegated mode: it refreshes
 * and signs out by POSTing to the app's auth routes (which read the cookie)
 * rather than talking to Convex directly, and it never persists a refresh token.
 *
 * Sign-in likewise runs on the server. A provider's SSR sibling hook (e.g.
 * {@link useAnonymousAuth}) POSTs to that provider's sign-in route; the route
 * mints the session, cookies the refresh token, and returns the access-only
 * {@link SlimTokenBundle}, which the hook adopts via `setSession`.
 *
 * @module
 */
"use client";

import { ConvexProviderWithAuth, ConvexReactClient } from "convex/react";
import { ReactNode, useCallback, useMemo } from "react";
import { AuthClient } from "../browser/sessionManager";
import {
  JWT_STORAGE_KEY,
  NamespacedStorage,
  TokenStorage,
  defaultStorage,
} from "../browser/storage";
import type { SlimTokenBundle } from "../lib/types";
import { useAuthActions } from "../react";
import { AuthProvider, useAuth } from "../react/client";

export { useConvexAuth } from "convex/react";
export { Authenticated, Unauthenticated, AuthLoading } from "convex/react";
export { useAuthActions, useAuthToken } from "../react";

/** POST JSON to an auth route and read back the access-only session. A failed
 * request is treated as "no session" rather than throwing, so a transient route
 * error degrades to signed-out instead of crashing the app. */
async function postAuth(
  route: string,
  body: Record<string, unknown>,
): Promise<{ tokens: SlimTokenBundle | null }> {
  const res = await fetch(route, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!res.ok) return { tokens: null };
  return (await res.json().catch(() => ({ tokens: null }))) as {
    tokens: SlimTokenBundle | null;
  };
}

/**
 * Wrap your app in this (in a Client Component, typically rendered by the
 * server-side `ConvexAuthNextjsServerProvider`) to enable authentication under
 * SSR.
 *
 * It owns the browser session — holding only the access token, refreshing it
 * against `refreshRoute`, and signing out against `signOutRoute` — and feeds
 * Convex's `ConvexProviderWithAuth`.
 */
export function ConvexAuthNextjsProvider({
  client,
  convexUrl,
  initialToken = null,
  refreshRoute = "/auth/refresh",
  signOutRoute = "/auth/signout",
  storage,
  children,
}: {
  /** An existing `ConvexReactClient`. If omitted, one is created from
   * `convexUrl` (or `NEXT_PUBLIC_CONVEX_URL`). */
  client?: ConvexReactClient;
  /** The Convex deployment URL. Defaults to `NEXT_PUBLIC_CONVEX_URL`. */
  convexUrl?: string;
  /** The access token read from the cookie on the server, so the browser
   * hydrates already authenticated. */
  initialToken?: string | null;
  /** Route that refreshes the access token from the httpOnly cookie. */
  refreshRoute?: string;
  /** Route that revokes the session and clears cookies. */
  signOutRoute?: string;
  /** A custom {@link TokenStorage}. Defaults to `localStorage` in the browser.
   * Only the access token is ever stored — never the refresh token. */
  storage?: TokenStorage;
  children: ReactNode;
}) {
  const { authClient, convex } = useMemo(() => {
    const convex =
      client ??
      new ConvexReactClient(convexUrl ?? process.env.NEXT_PUBLIC_CONVEX_URL!);
    const tokenStorage = storage ?? defaultStorage();
    const namespace = convex.url;
    // Hydrate the access token from the server-read cookie. Only the JWT —
    // there is no refresh token in JS; refresh reaches the cookie server-side.
    if (initialToken) {
      void new NamespacedStorage(tokenStorage, namespace).set(
        JWT_STORAGE_KEY,
        initialToken,
      );
    }
    const authClient = new AuthClient({
      authApi: {
        // The refresh token is read from the httpOnly cookie on the backend.
        refreshSession: async () => (await postAuth(refreshRoute, {})).tokens,
        signOut: async () => {
          await postAuth(signOutRoute, {});
        },
      },
      storage: tokenStorage,
      storageNamespace: namespace,
    });
    return { authClient, convex };
    // `client`/`convexUrl` identity is what matters; other props are read once.
  }, [client, convexUrl]);

  return (
    <AuthProvider authClient={authClient}>
      <ConvexProviderWithAuth client={convex} useAuth={useAuth}>
        {children}
      </ConvexProviderWithAuth>
    </AuthProvider>
  );
}

/**
 * SSR sibling of the anonymous provider's client-direct
 * `useAnonymousAuth` (`@convex-dev/auth/providers/anonymous/react`).
 *
 * Sign-in runs on the server: this POSTs to the anonymous sign-in route (where
 * `anonymousSignInHandler` is mounted), and adopts the access-only session it
 * returns. Unlike the client-direct hook it needs no function reference — the
 * route already binds the sign-in mutation.
 *
 * ```tsx
 * const { signInAnonymous } = useAnonymousAuth();
 * <button onClick={() => signInAnonymous()}>Sign in anonymously</button>;
 * ```
 */
export function useAnonymousAuth(options?: { route?: string }) {
  const { setSession } = useAuthActions();
  const route = options?.route ?? "/auth/signin/anonymous";
  const signInAnonymous = useCallback(async () => {
    const { tokens } = await postAuth(route, {});
    if (tokens) await setSession(tokens);
  }, [setSession, route]);
  return { signInAnonymous };
}
