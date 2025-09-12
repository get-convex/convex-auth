import "server-only";

import { fetchQuery } from "convex/nextjs";
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
} from "../client.js";
import { getRequestCookies, getRequestCookiesInMiddleware } from "./cookies.js";
import { proxyAuthActionToConvex, shouldProxyAuthAction } from "./proxy.js";
import { handleAuthenticationInRequest } from "./request.js";
import {
  logVerbose,
  setAuthCookies,
  setAuthCookiesInMiddleware,
  getConvexNextjsOptions,
} from "./utils.js";
import { IsAuthenticatedQuery } from "../../server/implementation/index.js";

/**
 * Wrap your app with this provider in your root `layout.tsx`.
 */
export async function ConvexAuthNextjsServerProvider(props: {
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
   * Callback to determine whether Convex Auth should handle the code parameter for a given request.
   * If not provided, Convex Auth will handle all code parameters.
   * If provided, Convex Auth will only handle code parameters when the callback returns true.
   */
  shouldHandleCode?: (() => boolean) | boolean;
  /**
   * Turn on debugging logs.
   */
  verbose?: boolean;
  /**
   * Children components can call Convex hooks
   * and [useAuthActions](https://labs.convex.dev/auth/api_reference/react#useauthactions).
   */
  children: ReactNode;
}) {
  const {
    apiRoute,
    storage,
    storageNamespace,
    shouldHandleCode,
    verbose,
    children,
  } = props;
  const serverState = await convexAuthNextjsServerState();
  return (
    <ConvexAuthNextjsClientProvider
      serverState={serverState}
      apiRoute={apiRoute}
      storage={storage}
      storageNamespace={storageNamespace}
      shouldHandleCode={shouldHandleCode}
      verbose={verbose}
    >
      {children}
    </ConvexAuthNextjsClientProvider>
  );
}

/**
 * Retrieve the token for authenticating calls to your
 * Convex backend from Server Components, Server Actions and Route Handlers.
 * @returns The token if the client is authenticated, otherwise `undefined`.
 */
export async function convexAuthNextjsToken() {
  return (await getRequestCookies()).token ?? undefined;
}

/**
 * Whether the client is authenticated, which you can check
 * in Server Actions, Route Handlers and Middleware.
 *
 * Avoid the pitfall of checking authentication state in layouts,
 * since they won't stop nested pages from rendering.
 */
export async function isAuthenticatedNextjs(
  options: {
    convexUrl?: string;
  } = {},
) {
  const cookies = await getRequestCookies();
  return isAuthenticated(cookies.token, options);
}

/**
 * In `convexAuthNextjsMiddleware`, you can use this context
 * to get the token and check if the client is authenticated in place of
 * `convexAuthNextjsToken` and `isAuthenticatedNextjs`.
 *
 * ```ts
 * export function convexAuthNextjsMiddleware(handler, options) {
 *   return async (request, event, convexAuth) => {
 *     if (!(await convexAuth.isAuthenticated())) {
 *       return nextjsMiddlewareRedirect(request, "/login");
 *     }
 *   };
 * }
 * ```
 */
export type ConvexAuthNextjsMiddlewareContext = {
  getToken: () => Promise<string | undefined>;
  isAuthenticated: () => Promise<boolean>;
};

/**
 * Options for the `convexAuthNextjsMiddleware` function.
 */
export type ConvexAuthNextjsMiddlewareOptions = {
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
  /**
   * The cookie config to use for the auth cookies.
   *
   * `maxAge` is the number of seconds the cookie will be valid for. If this is not set, the cookie will be a session cookie.
   *
   * See [MDN Web Docs](https://developer.mozilla.org/en-US/docs/Web/HTTP/Cookies#defining_the_lifetime_of_a_cookie)
   * for more information.
   */
  cookieConfig?: { maxAge: number | null };
  /**
   * Turn on debugging logs.
   */
  verbose?: boolean;
  /**
   * Callback to determine whether Convex Auth should handle the code parameter for a given request.
   * If not provided, Convex Auth will handle all code parameters.
   * If provided, Convex Auth will only handle code parameters when the callback returns true.
   */
  shouldHandleCode?:
    | ((request: NextRequest) => boolean | Promise<boolean>)
    | boolean;
};

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
    ctx: {
      event: NextFetchEvent;
      convexAuth: ConvexAuthNextjsMiddlewareContext;
    },
  ) => NextMiddlewareResult | Promise<NextMiddlewareResult>,
  options: ConvexAuthNextjsMiddlewareOptions = {},
): NextMiddleware {
  return async (request, event) => {
    const verbose = options.verbose ?? false;
    const cookieConfig = options.cookieConfig ?? { maxAge: null };
    if (cookieConfig.maxAge !== null && cookieConfig.maxAge <= 0) {
      throw new Error(
        "cookieConfig.maxAge must be null or a positive number of seconds",
      );
    }
    logVerbose(`Begin middleware for request with URL ${request.url}`, verbose);
    const requestUrl = new URL(request.url);
    // Proxy signIn and signOut actions to Convex backend
    const apiRoute = options?.apiRoute ?? "/api/auth";
    if (shouldProxyAuthAction(request, apiRoute)) {
      logVerbose(
        `Proxying auth action to Convex, path matches ${apiRoute} with or without trailing slash`,
        verbose,
      );
      return await proxyAuthActionToConvex(request, options);
    }
    logVerbose(
      `Not proxying auth action to Convex, path ${requestUrl.pathname} does not match ${apiRoute}`,
      verbose,
    );
    // Refresh tokens, handle code query param
    const authResult = await handleAuthenticationInRequest(request, options);

    // If redirecting, proceed, the middleware will run again on next request
    if (authResult.kind === "redirect") {
      logVerbose(
        `Redirecting to ${authResult.response.headers.get("Location")}`,
        verbose,
      );
      return authResult.response;
    }

    let response: Response | null = null;
    // Forward cookies to request for custom handler
    if (
      authResult.kind === "refreshTokens" &&
      authResult.refreshTokens !== undefined
    ) {
      logVerbose(`Forwarding cookies to request`, verbose);
      await setAuthCookiesInMiddleware(request, authResult.refreshTokens);
    }
    if (handler === undefined) {
      logVerbose(`No custom handler`, verbose);
      response = NextResponse.next({
        request: {
          headers: request.headers,
        },
      });
    } else {
      // Call the custom handler
      logVerbose(`Calling custom handler`, verbose);
      response =
        (await handler(request, {
          event,
          convexAuth: {
            getToken: async () => {
              const cookies = await getRequestCookiesInMiddleware(request);
              return cookies.token ?? undefined;
            },
            isAuthenticated: async () => {
              const cookies = await getRequestCookiesInMiddleware(request);
              return isAuthenticated(cookies.token, options);
            },
          },
        })) ??
        NextResponse.next({
          request: {
            headers: request.headers,
          },
        });
    }

    // Port the cookies from the auth middleware to the response
    if (
      authResult.kind === "refreshTokens" &&
      authResult.refreshTokens !== undefined
    ) {
      const nextResponse = NextResponse.next(response);
      await setAuthCookies(
        nextResponse,
        authResult.refreshTokens,
        cookieConfig,
      );
      return nextResponse;
    }

    return response;
  };
}

export { createRouteMatcher, RouteMatcherParam } from "./routeMatcher.js";

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

async function convexAuthNextjsServerState(): Promise<ConvexAuthServerState> {
  const { token } = await getRequestCookies();
  return {
    // The server doesn't share the refresh token with the client
    // for added security - the client has to use the server
    // to refresh the access token via cookies.
    _state: { token, refreshToken: "dummy" },
    _timeFetched: Date.now(),
  };
}

async function isAuthenticated(
  token: string | null,
  options: { convexUrl?: string },
): Promise<boolean> {
  if (!token) {
    return false;
  }
  try {
    return await fetchQuery(
      "auth:isAuthenticated" as any as IsAuthenticatedQuery,
      {},
      {
        ...getConvexNextjsOptions(options),
        token: token,
      },
    );
  } catch (e: any) {
    if (e.message.includes("Could not find public function")) {
      throw new Error(
        "Server Error: could not find api.auth.isAuthenticated. convex-auth 0.0.76 introduced a new export in convex/auth.ts. Add `isAuthenticated` to the list of functions returned from convexAuth(). See convex-auth changelog for more https://github.com/get-convex/convex-auth/blob/main/CHANGELOG.md",
      );
    } else {
      console.log("Returning false from isAuthenticated because", e);
    }
    return false;
  }
}
