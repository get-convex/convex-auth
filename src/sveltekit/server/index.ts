/**
 * Server-side handlers for Convex Auth in SvelteKit
 */
import {
  createConvexAuthHandlers,
  createConvexAuthHooks,
  convexAuthSvelteKitServerState,
} from "./handlers.js";
import {
  createRouteMatcher,
  type RouteMatcherParam,
  type RouteMatcherFn,
} from "./routeMatcher.js";

/**
 * Options for the `createConvexAuthHooks` function.
 */
export type ConvexAuthHooksOptions = {
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
  cookieConfig?: {
    path?: string;
    httpOnly?: boolean;
    secure?: boolean;
    maxAge?: number;
    sameSite?: "strict" | "lax" | "none";
    domain?: string;
  };
  /**
   * Turn on debugging logs.
   */
  verbose?: boolean;
};

// Export server handlers
export {
  createConvexAuthHandlers,
  createConvexAuthHooks,
  convexAuthSvelteKitServerState,
};

// Export route matchers (equivalent to NextJS implementation)
export { createRouteMatcher, type RouteMatcherParam, type RouteMatcherFn };
