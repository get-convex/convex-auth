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
 * Sign-in likewise runs on the server, but providers need no SSR-specific hook
 * for it. {@link ConvexAuthNextjsProvider} supplies an {@link AuthSignInApi} backed
 * by a `ConvexHttpClient` aimed at the SSR host's auth proxy, so a provider's
 * normal client hook works unchanged: the proxy mints the session, stashes the
 * refresh token in the cookie, and returns an access-only
 * {@link SlimTokenBundle} for the client to authenticate to Convex with.
 *
 * @module
 */
"use client";

import { ConvexHttpClient } from "convex/browser";
import { ConvexProviderWithAuth, ConvexReactClient } from "convex/react";
import { ReactNode, useMemo } from "react";
import { AuthClient } from "../browser/sessionManager.js";
import { TokenStorage, defaultStorage } from "../browser/storage.js";
import type { AuthSessionResponse } from "../lib/types.js";
import { AuthProvider, useAuth, type AuthSignInApi } from "../react/client.js";

export { useConvexAuth } from "convex/react";
export { Authenticated, Unauthenticated, AuthLoading } from "convex/react";
export { useAuthActions, useAuthToken } from "../react/index.js";

/**
 * POST to the refresh or sign-out route and read back the access-only bundle.
 *
 * These two have their own handlers rather than going through the auth proxy,
 * because the refresh token they need is in the cookie rather than in any
 * argument the client could pass. Both reply with an
 * {@link AuthSessionResponse} on failure as on success (a dead session is a 401
 * carrying `tokens: null`), so the body is parsed regardless of status. Anything
 * without a JSON body degrades to `tokens: null`.
 */
async function postAuth(route: string): Promise<AuthSessionResponse> {
  const res = await fetch(route, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: "{}",
  });
  return (await res
    .json()
    .catch(() => ({ tokens: null }))) as AuthSessionResponse;
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
  signInRoute = "/auth/signin",
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
  /** Route the auth proxy is mounted at, i.e. the single route file exporting
   * `auth.convexProxyHandler`. Provider sign-in calls go here. */
  signInRoute?: string;
  /** A custom {@link TokenStorage}. Defaults to `localStorage` in the browser.
   * Under SSR, it only stores the access token. */
  storage?: TokenStorage;
  children: ReactNode;
}) {
  const { authClient, convex, signInApi } = useMemo(() => {
    const convex =
      client ??
      new ConvexReactClient(convexUrl ?? process.env.NEXT_PUBLIC_CONVEX_URL!);
    const authClient = new AuthClient({
      mode: "ssr",
      authApi: {
        // The refresh token is read from the httpOnly cookie when it reaches the SSR host.
        refreshSession: async () => (await postAuth(refreshRoute)).tokens,
        signOut: async () => {
          await postAuth(signOutRoute);
        },
      },
      storage: storage ?? defaultStorage(),
      storageNamespace: convex.url,
      // The SSR host may have refreshed on our behalf, so this is the freshest
      // access token; the client adopts it on init.
      initialAccessToken: initialToken,
    });

    // Provider sign-in goes to the auth proxy so the minted refresh token can be
    // moved into an httpOnly cookie server-side. The proxy speaks the
    // `ConvexHttpClient` wire format, so this is a real Convex client pointed at
    // the SSR host: no bespoke request shape, and args and errors keep their
    // encoding. The address is relative, hence skipping the URL check, and
    // same-origin fetch sends the auth cookies automatically. The trailing
    // `?path=` puts the endpoint the client appends into the query string, so
    // `signInRoute` can be a static route rather than a catch-all.
    const proxy = new ConvexHttpClient(`${signInRoute}?path=`, {
      skipConvexDeploymentUrlCheck: true,
      logger: convex.logger,
    });
    // Attach the current access token per call: a sign-in typically runs
    // unauthenticated, but a function may want the existing identity (e.g. to
    // link an account to the signed-in user).
    const withAuth = () => {
      const token = authClient.getAccessToken();
      if (token !== null) proxy.setAuth(token);
      else proxy.clearAuth();
      return proxy;
    };
    const signInApi: AuthSignInApi = {
      mutation: (fn, args) => withAuth().mutation(fn, args),
      action: (fn, args) => withAuth().action(fn, args),
    };

    return { authClient, convex, signInApi };
    // `client`/`convexUrl` identity is what matters; other props are read once.
  }, [client, convexUrl]);

  return (
    <AuthProvider authClient={authClient} signInApi={signInApi}>
      <ConvexProviderWithAuth client={convex} useAuth={useAuth}>
        {children}
      </ConvexProviderWithAuth>
    </AuthProvider>
  );
}
