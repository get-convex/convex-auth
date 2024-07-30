import "server-only";

import { NextMiddlewareResult } from "next/dist/server/web/types";
import {
  NextFetchEvent,
  NextMiddleware,
  NextRequest,
  NextResponse,
} from "next/server";
import { ReactNode } from "react";
import {
  ConvexAuthNextjsClientProvider,
  ConvexAuthServerState,
} from "../client";
import { getRequestCookies } from "./cookies";
import { proxyAuthActionToConvex } from "./proxy";
import { handleAuthenticationInRequest } from "./request";

/**
 * Wrap your app with this provider in your root `layout.tsx`.
 */
export function ConvexAuthNextjsServerProvider({
  apiRoute,
  storage,
  storageNamespace,
  verbose,
  children,
}: {
  /**
   * You can customize the route path that handles authentication
   * actions via this prop and the `apiRoute` option to `convexAuthNextjsMiddleWare`.
   *
   * Defaults to `/api/auth`.
   */
  apiRoute?: string;
  /**
   * Choose how the auth information will be stored on the client.
   *
   * Defaults to `"localStorage"`.
   *
   * If you choose `"inMemory"`, different browser tabs will not
   * have a synchronized authentication state.
   */
  storage?: "localStorage" | "inMemory";
  /**
   * Optional namespace for keys used to store tokens. The keys
   * determine whether the tokens are shared or not.
   *
   * Any non-alphanumeric characters will be ignored.
   *
   * Defaults to `process.env.NEXT_PUBLIC_CONVEX_URL`.
   */
  storageNamespace?: string;
  /**
   * Turn on debugging logs.
   */
  verbose?: boolean;
  /**
   * Children components can call Convex hooks
   * and {@link useAuthActions}.
   */
  children: ReactNode;
}) {
  return (
    <ConvexAuthNextjsClientProvider
      serverState={convexAuthNextjsServerState()}
      apiRoute={apiRoute}
      storage={storage}
      storageNamespace={storageNamespace}
      verbose={verbose}
    >
      {children}
    </ConvexAuthNextjsClientProvider>
  );
}

export function convexAuthNextjsToken() {
  return getRequestCookies().token ?? undefined;
}

export function isAuthenticatedNextjs() {
  return convexAuthNextjsToken() !== undefined;
}

export function AuthenticatedNextjs({ children }: { children: ReactNode }) {
  return isAuthenticatedNextjs() ? <>{children}</> : null;
}

export function UnauthenticatedNextjs({ children }: { children: ReactNode }) {
  return isAuthenticatedNextjs() ? null : <>{children}</>;
}

export function convexAuthNextjsMiddleware(
  handler?: (
    request: NextRequest,
    event: NextFetchEvent,
  ) => NextMiddlewareResult | Promise<NextMiddlewareResult>,
  options: {
    /**
     * The URL of the Convex deployment to use for authentication.
     *
     * Defaults to `process.env.NEXT_PUBLIC_CONVEX_URL`.
     */
    convexUrl?: string;
    /**
     * You can customize the route path that handles authentication
     * actions via this option and the `apiRoute` prop of `ConvexAuthNextjsProvider`.
     *
     * Defaults to `/api/auth`.
     */
    apiRoute?: string;
  } = {},
): NextMiddleware {
  return async (request, event) => {
    const requestUrl = new URL(request.url);
    // Proxy signIn and signOut actions to Convex backend
    if (requestUrl.pathname === (options?.apiRoute ?? "/api/auth")) {
      return await proxyAuthActionToConvex(request, options);
    }
    // Refresh tokens, handle code query param
    const authResult = await handleAuthenticationInRequest(request);

    // If redirecting, proceed, the middleware will run again on next request
    if (authResult?.headers.get("Location")) {
      return authResult;
    }

    // Forward cookies to request for custom handler
    if (handler !== undefined && authResult.headers) {
      authResult.cookies.getAll().forEach((cookie) => {
        request.cookies.set(cookie.name, cookie.value);
      });
    }

    // Maybe call the custom handler
    const response = (await handler?.(request, event)) ?? NextResponse.next();

    // Port the cookies from the auth middleware to the response
    if (authResult.headers) {
      authResult.headers.forEach((value, key) => {
        response.headers.append(key, value);
      });
    }

    return response;
  };
}

export { createRouteMatcher } from "./routeMatcher";

/**
 * Helper for redirecting to a different route from
 * a Next.js middleware.
 *
 * ```ts
 * return nextjsMiddlewareRedirect(request, "/login");
 * ```
 */
export function nextjsMiddlewareRedirect(
  /**
   * The incoming request handled by the middleware.
   */
  request: NextRequest,
  /**
   * The route path to redirect to.
   */
  pathname: string,
) {
  const url = request.nextUrl.clone();
  url.pathname = pathname;
  return NextResponse.redirect(url);
}

// Initial page load
// nothing

// Sign in: (say email + password)
// has to go through Next.js server (route handler instead of Convex Action)
// from the API route, we call the Convex Action
// we get back the tokens
// we set the tokens on cookies
// we also return the tokens to the client

// Page reload (access token still valid)
// We read the cookies
// We trust the cookie (developers have to revalidate themselves)
// make the token available for fetchQuery
// server components can call fetchQuery(api.foo.bar, {}, {token})
// we pass the tokens to the client provider (this means the client provider does not! have to use localStorage (double check))
// (so the client provider has the tokens available without any async calls and can immediately authenticate)

// Page reload (access token expired)
// We read the cookies
// We can see that the access token is invalid (or soon expires, we need some grace period, configurable)
// We refresh the token via signIn action
// We set the new tokens on cookies
// we pass the tokens to the client provider

// Sign out
// client calls Next.js server route handler
// we remove the cookies
// we return to client
// client deletes the tokens from memory

// to protect against CSRF we check origin header

// The client will try to refresh the token
// That has to go through the Next.js server too

// If we do use localStorage, we will be able to sync the state
// between browser tabs (sign in and sign out),
// not using localStorage probably doesn't offer much better security

function convexAuthNextjsServerState(): ConvexAuthServerState {
  const { token, refreshToken } = getRequestCookies();
  return {
    _state: { token, refreshToken },
    _timeFetched: Date.now(),
  };
}
