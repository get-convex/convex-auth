/**
 * Server-side handlers for Convex Auth in SvelteKit
 */
import {
  createConvexAuthHandlers,
  createConvexAuthHooks,
} from "./handlers.js";
import {
  createRouteMatcher,
  type RouteMatcherParam,
  type RouteMatcherFn,
} from "./routeMatcher.js";
import type { CookieOptions } from "./cookies.js";
import { ConvexAuthServerState } from "../../svelte/index.svelte.js";

/**
 * Options for the createConvexAuthHandlers and createConvexAuthHooks functions
 */
export interface ConvexAuthHooksOptions {
  /**
   * The URL of the Convex deployment to use for authentication.
   * Defaults to process.env.CONVEX_URL or process.env.PUBLIC_CONVEX_URL.
   */
  convexUrl?: string;

  /**
   * The route path that handles authentication actions.
   * Defaults to "/api/auth".
   */
  apiRoute?: string;

  /**
   * The cookie config to use for the auth cookies.
   * Defaults to { path: "/", httpOnly: true, secure: true in production, sameSite: "lax" }
   */
  cookieConfig?: CookieOptions;

  /**
   * Turn on debugging logs.
   * Defaults to false.
   */
  verbose?: boolean;
}

/**
 * Result of an auth token refresh operation
 */
export interface RefreshResult {
  /**
   * Updated auth state if refresh succeeded
   */
  authState?: ConvexAuthServerState;
  
  /**
   * Whether the refresh failed and user needs to sign in again
   */
  signInRequired?: boolean;
}

// Export server handlers
export {
  createConvexAuthHandlers,
  createConvexAuthHooks,
  createRouteMatcher,
};

// Export types
export type { RouteMatcherParam, RouteMatcherFn };
