/**
 * Client bindings for Convex Auth on Next.js (App Router), exported at
 * `@convex-dev/auth/nextjs`.
 *
 * When running under SSR, authentication is performed for two parties:
 *
 *  1. The Convex client (for all of the reactive/transactional client-side
 *     goodness)
 *  2. The browser itself (for authenticated requests to the SSR host)
 *
 * Under SSR the refresh token lives only in a server-only httpOnly cookie, so
 * client JS can only read the access token. {@link ConvexAuthNextjsProvider}
 * configures the core {@link AuthClient} in that mode: it refreshes and signs
 * out by POSTing to the SSR host's auth routes (which read the cookie) rather
 * than talking to Convex directly.
 *
 * Sign-in likewise runs on the server. A provider's SSR sibling hook (e.g.
 * {@link useAnonymousAuth}) POSTs to that provider's sign-in route mounted on
 * the SSR host; the handler there mints the session, stashes the refresh token
 * in the cookie, and returns a {@link SlimTokenBundle} which only contains the
 * access token (for the client to authenticate to the Convex backend).
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

/** POST JSON to an auth route and read back the result with the access token. */
// TODO: dowski - what sort of error handling/guarantees do we want here?
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
 * It holds the {@link ConvexReactClient} and wraps it with {@link
 * ConvexProviderWithAuth} so it is properly configured for the SSR auth
 * environment.
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
  /** The access token from SSR host, if available, so the Convex client
   * hydrates ready to authenticate. */
  initialToken?: string | null;
  /** Route that refreshes the access token from the httpOnly cookie. */
  refreshRoute?: string;
  /** Route that revokes the session and clears cookies. */
  signOutRoute?: string;
  /** A custom {@link TokenStorage}. Defaults to `localStorage` in the browser.
   * Under SSR, it only stores the access token. */
  storage?: TokenStorage;
  children: ReactNode;
}) {
  const { authClient, convex } = useMemo(() => {
    const convex =
      client ??
      new ConvexReactClient(convexUrl ?? process.env.NEXT_PUBLIC_CONVEX_URL!);
    const tokenStorage = storage ?? defaultStorage();
    const namespace = convex.url;
    // Make the access token available under the expected storage key.
    if (initialToken) {
      void new NamespacedStorage(tokenStorage, namespace).set(
        JWT_STORAGE_KEY,
        initialToken,
      );
    }
    const authClient = new AuthClient({
      authApi: {
        // The refresh token is read from the httpOnly cookie when it reaches the SSR host.
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
 * Sign-in runs on the SSR host: this POSTs to the anonymous sign-in route (where
 * `anonymousSignInHandler` is mounted), and adopts the access-only session it
 * returns.
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
