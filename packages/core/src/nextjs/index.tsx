/**
 * Client bindings for Convex Auth on Next.js (App Router), exported at
 * `@convex-dev/auth/nextjs`.
 *
 * Under SSR the refresh token is stored in an httpOnly cookie on the SSR host,
 * so client JavaScript only reads the access token. The auth client from
 * {@link createNextjsAuthClient} refreshes and signs out by POSTing to the SSR
 * host's auth routes, which read the cookie.
 *
 * Sign-in also runs through the SSR host. The auth client's sign-in API is a
 * `ConvexHttpClient` pointed at the auth proxy route, so a provider's client
 * hook works unchanged. The proxy mints the session, moves the refresh token
 * into the cookie, and returns an access-only {@link SlimTokenBundle}.
 *
 * A Server Component cannot pass the auth client to a Client Component, so the
 * app builds both clients in its own client file.
 *
 * ```tsx
 * "use client";
 *
 * import {
 *   ConvexAuthNextjsProvider,
 *   createNextjsAuthClient,
 * } from "@convex-dev/auth/nextjs";
 * import { ConvexReactClient } from "convex/react";
 * import type { ReactNode } from "react";
 *
 * const convex = new ConvexReactClient(process.env.NEXT_PUBLIC_CONVEX_URL!);
 * const auth = createNextjsAuthClient({
 *   url: process.env.NEXT_PUBLIC_CONVEX_URL!,
 * });
 *
 * export function ConvexClientProvider({
 *   initialToken,
 *   children,
 * }: {
 *   initialToken: string | null;
 *   children: ReactNode;
 * }) {
 *   return (
 *     <ConvexAuthNextjsProvider
 *       client={convex}
 *       auth={auth}
 *       initialToken={initialToken}
 *     >
 *       {children}
 *     </ConvexAuthNextjsProvider>
 *   );
 * }
 * ```
 *
 * The root layout reads the token with `convexAuthNextjsAccessToken()` from
 * `@convex-dev/auth/nextjs/server` and renders `ConvexClientProvider` with it.
 *
 * @module
 */
"use client";

import { ConvexHttpClient } from "convex/browser";
import { ConvexProviderWithAuth, ConvexReactClient } from "convex/react";
import { ReactNode } from "react";
import type { HttpClientLogger } from "../browser/createAuthClient.ts";
import { retryOnNetworkError } from "../browser/retry.ts";
import { AuthClient } from "../browser/sessionManager.ts";
import { TokenStorage, defaultStorage } from "../browser/storage.ts";
import type { AuthSessionResponse } from "../lib/types.ts";
import { AuthProvider, useAuth } from "../react/client.tsx";

export { useConvexAuth } from "convex/react";
export { Authenticated, Unauthenticated, AuthLoading } from "convex/react";
export type { AuthClient } from "../browser/sessionManager.ts";
export { useAuthClient } from "../react/client.tsx";
export { useAuthActions, useAuthToken } from "../react/index.tsx";

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

/** Options for {@link createNextjsAuthClient}. */
export type CreateNextjsAuthClientOptions = {
  /** The Convex deployment URL. */
  url: string;
  /** The route that refreshes the access token from the httpOnly cookie. */
  refreshRoute?: string;
  /** The route that revokes the session and clears the cookies. */
  signOutRoute?: string;
  /**
   * The route of the auth proxy, which is the route file that exports
   * `auth.convexProxyHandler`. Sign-in calls go here.
   */
  signInRoute?: string;
  /**
   * Where the access token is stored. Defaults to `localStorage` in the
   * browser.
   */
  storage?: TokenStorage;
  /** The namespace for storage keys. Defaults to `url`. */
  storageNamespace?: string;
  /** The logger for the HTTP client that calls the auth proxy. */
  logger?: HttpClientLogger;
  /** Log refresh and lifecycle steps to the console. */
  verbose?: boolean;
};

/**
 * Create the auth client of a Next.js app. Build it once, at module scope in
 * a `"use client"` file, and pass it to {@link ConvexAuthNextjsProvider}. The
 * routes default to `/auth/refresh`, `/auth/signout`, and `/auth/signin`.
 */
export function createNextjsAuthClient(
  options: CreateNextjsAuthClientOptions,
): AuthClient {
  const {
    url,
    refreshRoute = "/auth/refresh",
    signOutRoute = "/auth/signout",
    signInRoute = "/auth/signin",
  } = options;
  const auth = new AuthClient({
    mode: "ssr",
    authApi: {
      // The SSR host reads the refresh token from the httpOnly cookie.
      refreshSession: async () => (await postAuth(refreshRoute)).tokens,
      signOut: async () => {
        await postAuth(signOutRoute);
      },
    },
    storage: options.storage ?? defaultStorage(),
    storageNamespace: options.storageNamespace ?? url,
    verbose: options.verbose,
  });

  // Sign-in goes to the auth proxy so the SSR host can move the minted refresh
  // token into an httpOnly cookie. The proxy speaks the `ConvexHttpClient`
  // wire format, so args and errors keep their encoding. The address is
  // relative, which is why the URL check is skipped, and a same-origin fetch
  // sends the auth cookies. The trailing `?path=` puts the endpoint the client
  // appends into the query string, so `signInRoute` can be a static route.
  const proxy = new ConvexHttpClient(`${signInRoute}?path=`, {
    skipConvexDeploymentUrlCheck: true,
    logger: options.logger,
  });
  // A sign-in usually runs signed out, but a function may use the current
  // identity, for example to link an account to the signed-in user. So each
  // call sends the current access token.
  const withAuth = () => {
    const token = auth.getAccessToken();
    if (token !== null) proxy.setAuth(token);
    else proxy.clearAuth();
    return proxy;
  };
  // The proxy HTTP client does not re-send a request after a network error,
  // so each sign-in call retries.
  auth.setSignInApi({
    mutation: (fn, args) =>
      retryOnNetworkError(() => withAuth().mutation(fn, args)),
    action: (fn, args) =>
      retryOnNetworkError(() => withAuth().action(fn, args)),
  });
  return auth;
}

/**
 * Wrap your app in this, in a Client Component, to enable authentication
 * under SSR. See the module docs for an example.
 */
export function ConvexAuthNextjsProvider({
  client,
  auth,
  initialToken = null,
  children,
}: {
  /** Your `ConvexReactClient`. */
  client: ConvexReactClient;
  /** The auth client from {@link createNextjsAuthClient}. */
  auth: AuthClient;
  /**
   * The access token from the SSR host, so the Convex client starts ready to
   * authenticate. The client stores it on its first `init()` call.
   */
  initialToken?: string | null;
  children: ReactNode;
}) {
  return (
    <AuthProvider authClient={auth} initialAccessToken={initialToken}>
      <ConvexProviderWithAuth client={client} useAuth={useAuth}>
        {children}
      </ConvexProviderWithAuth>
    </AuthProvider>
  );
}
