/**
 * Server-side handlers for Convex Auth in SvelteKit
 */
import type { RequestEvent } from "@sveltejs/kit";
import { ConvexAuthHooksOptions } from "./index.js";
import { shouldProxyAuthAction, proxyAuthActionToConvex } from "./proxy.js";
import { getConvexUrl, logVerbose, setupClient } from "./utils.js";
import {
  AUTH_TOKEN_COOKIE,
  AUTH_REFRESH_TOKEN_COOKIE,
  setAuthCookies,
  defaultCookieOptions,
} from "./cookies.js";
import { IsAuthenticatedQuery } from "../../server/implementation/index.js";
import { handleAuthenticationInRequest } from "./request.js";
import { ConvexAuthServerState } from "../../svelte/index.svelte.js";
import { ConvexHttpClient, ConvexClientOptions } from "convex/browser";

/**
 * Create server-side handlers for SvelteKit
 * Use this in your server hooks files (+layout.server.ts, +page.server.ts, server.ts, etc.)
 */
export function createConvexAuthHandlers({
  convexUrl = getConvexUrl(),
}: ConvexAuthHooksOptions = {}) {
  /**
   * Get the auth state from cookies
   */
  async function getAuthState(
    event: RequestEvent,
  ): Promise<ConvexAuthServerState> {
    // Get tokens from cookies
    const token = event.cookies.get(AUTH_TOKEN_COOKIE) || null;
    const refreshToken = event.cookies.get(AUTH_REFRESH_TOKEN_COOKIE) || null;

    return {
      _state: { token, refreshToken },
      _timeFetched: Date.now(),
    };
  }

  /**
   * Check if the client is authenticated with Convex
   */
  async function isAuthenticated(event: RequestEvent): Promise<boolean> {
    const token = event.cookies.get(AUTH_TOKEN_COOKIE);
    if (!token) {
      return false;
    }

    // Validate the token with Convex
    try {
      const client = setupClient({
        url: convexUrl,
        token,
      });
      const result = await client.query(
        "auth:isAuthenticated" as any as IsAuthenticatedQuery,
      );
      return !!result;
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

  /**
   * Create a Convex HTTP client.
   *
   * Returns an authenticated HTTP client if the user is signed in,
   * otherwise returns an unauthenticated HTTP client.
   */
  async function createConvexHttpClient(
    event: RequestEvent,
    options?: {
      skipConvexDeploymentUrlCheck?: boolean;
      logger?: ConvexClientOptions["logger"];
    },
  ) {
    const token = event.cookies.get(AUTH_TOKEN_COOKIE);
    const client = new ConvexHttpClient(convexUrl, options);
    if (token) {
      client.setAuth(token);
    }
    return client;
  }

  return {
    getAuthState,
    isAuthenticated,
    createConvexHttpClient,
  };
}

// Type definitions for the handle function
interface HandleArgs {
  event: RequestEvent;
  resolve: (event: RequestEvent) => Response | Promise<Response>;
}

/**
 * Create server hooks for SvelteKit
 * Use this in your hooks.server.ts file
 */
export function createConvexAuthHooks({
  convexUrl = getConvexUrl(),
  apiRoute = "/api/auth",
  cookieConfig: cookieConfigOverride,
  verbose = false,
}: ConvexAuthHooksOptions = {}) {
  const cookieConfig = cookieConfigOverride ?? defaultCookieOptions;

  const handlers = createConvexAuthHandlers({ convexUrl });

  /**
   * Request handler for the hooks.server.ts handle function
   */
  async function handleAuth({ event, resolve }: HandleArgs) {
    if (
      cookieConfig &&
      cookieConfig.maxAge != null &&
      cookieConfig.maxAge <= 0
    ) {
      throw new Error(
        "cookieConfig.maxAge must be a positive number of seconds if specified (not 0 or negative)",
      );
    }

    logVerbose(
      `Begin middleware for request with URL ${event.url.toString()}`,
      verbose,
    );
    // Proxy signIn and signOut actions to Convex backend
    if (shouldProxyAuthAction(event, apiRoute)) {
      logVerbose(
        `Proxying auth action to Convex, path matches ${apiRoute} with or without trailing slash`,
        verbose,
      );
      const result = await proxyAuthActionToConvex(
        event,
        convexUrl,
        cookieConfig,
        verbose,
      );
      return result;
    }
    logVerbose(
      `Not proxying auth action to Convex, path ${event.url.pathname} does not match ${apiRoute}`,
      verbose,
    );

    // Refresh tokens, handle code query param
    const authResult = await handleAuthenticationInRequest(event, {
      convexUrl,
      apiRoute,
      cookieConfig,
      verbose,
    });

    // If redirecting, proceed, the middleware will run again on next request
    if (authResult.kind === "redirect") {
      logVerbose(
        `Redirecting to ${authResult.response.headers.get("Location")}`,
        verbose,
      );
      return authResult.response;
    }

    // Create a response using the resolver
    const response = await resolve(event);

    // Add auth cookies to the response if tokens were refreshed
    if (
      authResult.kind === "refreshTokens" &&
      authResult.refreshTokens !== undefined
    ) {
      if (authResult.refreshTokens !== null) {
        setAuthCookies(
          response,
          authResult.refreshTokens.token,
          authResult.refreshTokens.refreshToken,
          cookieConfig,
          verbose,
        );
      } else {
        setAuthCookies(response, null, null, cookieConfig, verbose);
      }
    }

    return response;
  }

  return {
    ...handlers,
    handleAuth,
  };
}
