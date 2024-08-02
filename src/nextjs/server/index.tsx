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
export function ConvexAuthNextjsServerProvider(props: {
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
  const { apiRoute, storage, storageNamespace, verbose, children } = props;
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

/**
 * Retrieve the token for authenticating calls to your
 * Convex backend from Server Components, Server Actions and Route Handlers.
 * @returns The token if the the client is authenticated, otherwise `undefined`.
 */
export function convexAuthNextjsToken() {
  return getRequestCookies().token ?? undefined;
}

/**
 * Whether the client is authenticated, which you can check
 * in Server Actions, Route Handlers and Middleware.
 *
 * Avoid the pitfall of checking authentication state in layouts,
 * since they won't stop nested pages from rendering.
 */
export function isAuthenticatedNextjs() {
  return convexAuthNextjsToken() !== undefined;
}

/**
 * Use in your `middleware.ts` to enable your Next.js app to use
 * Convex Auth for authentication on the server.
 *
 * @returns A Next.js middleware.
 */
export function convexAuthNextjsMiddleware(
  /**
   * A custom handler, which you can use to decide
   * which routes should be accessible based on the client's authentication.
   */
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

export { createRouteMatcher, RouteMatcherParam } from "./routeMatcher";

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

function convexAuthNextjsServerState(): ConvexAuthServerState {
  const { token } = getRequestCookies();
  return {
    // The server doesn't share the refresh token with the client
    // for added security - the client has to use the server
    // to refresh the access token via cookies.
    _state: { token, refreshToken: "dummy" },
    _timeFetched: Date.now(),
  };
}
