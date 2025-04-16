/**
 * Server-side handlers for Convex Auth in SvelteKit
 */
import type { RequestEvent, RequestHandler } from "@sveltejs/kit";
import type { ConvexAuthServerState } from "../client.js";
import { json, error } from "@sveltejs/kit";

// Interface for cookie options
interface CookieOptions {
  path?: string;
  httpOnly?: boolean;
  secure?: boolean;
  maxAge?: number;
  sameSite?: "strict" | "lax" | "none";
  domain?: string;
}

// Cookie names
const AUTH_TOKEN_COOKIE = "__convex_auth_token";
const AUTH_REFRESH_TOKEN_COOKIE = "__convex_auth_refresh_token";

// Default cookie options
const defaultCookieOptions: CookieOptions = {
  path: "/",
  httpOnly: true,
  secure: process.env.NODE_ENV === "production",
  sameSite: "lax",
};

// For debug logging
function logVerbose(message: string, ...args: any[]) {
  if (process.env.CONVEX_AUTH_DEBUG === "true") {
    console.log(`[ConvexAuth] ${message}`, ...args);
  }
}

/**
 * Helper to get the Convex URL from environment variables
 * This allows SvelteKit implementations to automatically use the URL
 */
function getConvexUrl(): string {
  // Try to load from process.env.PUBLIC_CONVEX_URL first
  const envUrl = process.env.PUBLIC_CONVEX_URL;
  
  if (envUrl) {
    return envUrl;
  }
  
  // If running in Node.js environment, could try to load from .env file
  // but this is usually handled by SvelteKit's config
  
  throw new Error(
    "Convex URL not provided. Either pass convexUrl parameter or set PUBLIC_CONVEX_URL environment variable."
  );
}

/**
 * Create server-side handlers for SvelteKit
 */
export function createConvexAuthHandlers({
  convexUrl = getConvexUrl(),
  cookieOptions = defaultCookieOptions,
}: {
  convexUrl?: string;
  cookieOptions?: CookieOptions;
} = {}) {
  /**
   * Get the auth state from cookies
   */
  async function getAuthState(event: RequestEvent): Promise<ConvexAuthServerState> {
    // Get tokens from cookies
    const token = event.cookies.get(AUTH_TOKEN_COOKIE) || null;
    const refreshToken = event.cookies.get(AUTH_REFRESH_TOKEN_COOKIE) || null;

    return {
      _state: { token, refreshToken },
      _timeFetched: Date.now(),
    };
  }

  /**
   * Set auth cookies
   */
  function setAuthCookies(
    event: RequestEvent,
    token: string | null,
    refreshToken: string | null
  ) {
    logVerbose("Setting auth cookies", { token: !!token, refreshToken: !!refreshToken });
    
    if (token === null) {
      event.cookies.delete(AUTH_TOKEN_COOKIE, cookieOptions);
    } else {
      event.cookies.set(AUTH_TOKEN_COOKIE, token, { 
        ...cookieOptions,
        maxAge: 60 * 60 // 1 hour for the main token
      });
    }

    if (refreshToken === null) {
      event.cookies.delete(AUTH_REFRESH_TOKEN_COOKIE, cookieOptions);
    } else {
      event.cookies.set(AUTH_REFRESH_TOKEN_COOKIE, refreshToken, {
        ...cookieOptions,
        maxAge: 60 * 60 * 24 * 30 // 30 days for refresh token
      });
    }
  }

  /**
   * Proxy an auth action to Convex
   * Used to forward authentication requests to Convex
   */
  async function proxyAuthActionToConvex(
    event: RequestEvent,
    action: string,
    args: any
  ) {
    logVerbose("Proxying auth action to Convex", { action, args });

    try {
      // Forward the request to Convex
      const response = await fetch(`${convexUrl}/api/action`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          path: action,
          args,
        }),
      });

      if (!response.ok) {
        throw new Error(`Failed to proxy auth action: ${response.statusText}`);
      }

      const result = await response.json();
      logVerbose("Proxy result", result);

      // Handle authentication results
      if (result.tokens) {
        setAuthCookies(
          event,
          result.tokens.token,
          result.tokens.refreshToken
        );
      } else if (result.clearTokens) {
        setAuthCookies(event, null, null);
      }

      return result;
    } catch (e) {
      console.error("Error proxying auth action:", e);
      throw error(500, "Error proxying auth action to Convex");
    }
  }

  /**
   * Create a SvelteKit API handler for auth actions
   * This should be used in a +server.ts file at your desired API route (default: /api/auth)
   */
  const handleAuthAction: RequestHandler = async (event) => {
    try {
      const body = await event.request.json();
      const { action, args } = body;

      // Only allow auth-related actions to be proxied
      if (!action.startsWith("auth:")) {
        throw error(403, "Only auth actions are allowed");
      }

      const result = await proxyAuthActionToConvex(event, action, args);
      return json(result);
    } catch (e) {
      console.error("Error in auth action handler:", e);
      throw error(500, "Error processing auth action");
    }
  };

  /**
   * Load function for layout/page to get auth state
   * Use in +layout.server.ts or +page.server.ts
   */
  async function loadAuthState(event: RequestEvent) {
    return {
      authState: await getAuthState(event),
    };
  }

  /**
   * Determine if the current request is authenticated
   */
  async function isAuthenticated(event: RequestEvent): Promise<boolean> {
    const authState = await getAuthState(event);
    return !!authState._state.token;
  }

  return {
    getAuthState,
    setAuthCookies,
    handleAuthAction,
    loadAuthState,
    proxyAuthActionToConvex,
    isAuthenticated,
  };
}

/**
 * Get the server-side auth state
 * This is similar to the Next.js convexAuthNextjsServerState function
 */
export async function convexAuthSvelteKitServerState(
  event: RequestEvent
): Promise<ConvexAuthServerState> {
  const token = event.cookies.get(AUTH_TOKEN_COOKIE) || null;
  
  // The server doesn't share the refresh token with the client
  // for added security - the client has to use the server
  // endpoint to refresh the token
  return {
    _state: { token, refreshToken: null },
    _timeFetched: Date.now(),
  };
}

// Type definitions for the handle function
interface HandleArgs {
  event: RequestEvent;
  resolve: (event: RequestEvent) => Promise<Response>;
}

/**
 * Create server hooks for SvelteKit
 * Use this in your hooks.server.ts file
 */
export function createConvexAuthHooks({
  convexUrl = getConvexUrl(),
  apiRoute = "/api/auth",
  cookieOptions,
}: {
  convexUrl?: string;
  apiRoute?: string;
  cookieOptions?: CookieOptions;
} = {}) {
  const handlers = createConvexAuthHandlers({ convexUrl, cookieOptions });

  /**
   * Request handler for the hooks.server.ts handle function
   */
  async function handleAuth({ event, resolve }: HandleArgs) {
    // If this is the auth API route, handle the auth action
    if (event.url.pathname === apiRoute && event.request.method === "POST") {
      return handlers.handleAuthAction(event);
    }

    // For other routes, just continue
    return resolve(event);
  }

  return {
    ...handlers,
    handleAuth
  };
}
