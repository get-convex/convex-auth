/**
 * Server-side handlers for Convex Auth in SvelteKit
 */
import cookie from "cookie";
import type { RequestEvent } from "@sveltejs/kit";
import type { ConvexAuthServerState } from "../client.js";
import { json } from "@sveltejs/kit";
import { ConvexAuthHooksOptions } from "./index";
import { shouldProxyAuthAction } from "./proxy.js";
import {
  getConvexUrl,
  isCorsRequest,
  logVerbose,
  setupClient,
} from "./utils.js";
import { SignInAction } from "@convex-dev/auth/server";

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
const AUTH_TOKEN_COOKIE = "__convexAuthJWT";
const AUTH_REFRESH_TOKEN_COOKIE = "__convexAuthRefreshToken";

// Default cookie options
const defaultCookieOptions: CookieOptions = {
  path: "/",
  httpOnly: true,
  secure: process.env.NODE_ENV === "production",
  sameSite: "lax",
};

/**
 * Create server-side handlers for SvelteKit
 */
export function createConvexAuthHandlers({
  convexUrl = getConvexUrl(),
  cookieConfig = defaultCookieOptions,
  verbose = false,
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
   * Set auth cookies
   */
  function setAuthCookies(
    response: Response,
    token: string | null,
    refreshToken: string | null,
  ) {
    logVerbose(
      `Setting auth cookies { token: ${!!token}, refreshToken: ${!!refreshToken} }`,
      verbose,
    );

    if (token === null) {
      // To delete a cookie, we need to set it with an expired date/max-age
      response.headers.append(
        "set-cookie",
        cookie.serialize(AUTH_TOKEN_COOKIE, "", {
          ...cookieConfig,
          maxAge: 0, // Setting max-age to 0 tells the browser to delete it immediately
          expires: new Date(0), // Setting an expired date as backup
        }),
      );
    } else {
      response.headers.append(
        "set-cookie",
        cookie.serialize(AUTH_TOKEN_COOKIE, token, {
          ...cookieConfig,
          maxAge:
            cookieConfig.maxAge === undefined
              ? 60 * 60 // 1 hour for the main token
              : cookieConfig.maxAge,
        }),
      );
    }

    if (refreshToken === null) {
      // To delete a cookie, we need to set it with an expired date/max-age
      response.headers.append(
        "set-cookie",
        cookie.serialize(AUTH_REFRESH_TOKEN_COOKIE, "", {
          ...cookieConfig,
          maxAge: 0, // Setting max-age to 0 tells the browser to delete it immediately
          expires: new Date(0), // Setting an expired date as backup
        }),
      );
    } else {
      response.headers.append(
        "set-cookie",
        cookie.serialize(AUTH_REFRESH_TOKEN_COOKIE, refreshToken, {
          ...cookieConfig,
          maxAge:
            cookieConfig.maxAge === undefined
              ? 60 * 60 * 24 * 30 // 30 days for refresh token
              : cookieConfig.maxAge,
        }),
      );
    }
  }

  /**
   * Proxy an auth action to Convex
   * Used to forward authentication requests to Convex
   */
  async function proxyAuthActionToConvex(event: RequestEvent) {
    const { action, args } = await event.request.json();
    logVerbose(
      `Proxying auth action to Convex { action: ${action}, args: ${JSON.stringify(
        {
          ...args,
          refreshToken: args?.refreshToken ? "[redacted]" : undefined,
        },
      )} }`,
      verbose,
    );

    if (isCorsRequest(event.request)) {
      return new Response("Invalid origin", { status: 403 });
    }

    if (action !== "auth:signIn" && action !== "auth:signOut") {
      logVerbose(`Invalid action ${action}, returning 400`, verbose);
      return new Response("Invalid action", { status: 400 });
    }

    let token: string | undefined;

    if (action === "auth:signIn" && args.refreshToken !== undefined) {
      // The client has a dummy refreshToken, the real one is only stored in cookies
      const refreshToken = event.cookies.get(AUTH_REFRESH_TOKEN_COOKIE);
      if (refreshToken === null) {
        console.error(
          "Convex Auth: Unexpected missing refreshToken cookie during client refresh",
        );
        return json({ tokens: null });
      }
      args.refreshToken = refreshToken;
    } else {
      // Make sure the proxy is authenticated if the client is,
      // important for signOut and any other logic working with existing sessions
      token = event.cookies.get(AUTH_TOKEN_COOKIE) ?? undefined;
    }

    // Add verifier from cookie if we're processing a code verification and verifier wasn't already provided
    if (
      action === "auth:signIn" &&
      args.params?.code !== undefined &&
      !args.verifier
    ) {
      const verifier = event.cookies.get("verifier");
      if (verifier) {
        args.verifier = verifier;
      }
    }

    logVerbose(
      `Fetching action ${action} with args ${JSON.stringify({
        ...args,
        refreshToken: args?.refreshToken ? "[redacted]" : undefined,
      })}`,
      verbose,
    );

    if (action === "auth:signIn") {
      let result: SignInAction["_returnType"];
      // Do not require auth when refreshing tokens or validating a code since they
      // are steps in the auth flow
      const clientOptions: { url: string; token?: string } = { url: convexUrl };
      if (
        !(args.refreshToken !== undefined || args.params?.code !== undefined)
      ) {
        clientOptions.token = token;
      }

      try {
        const client = setupClient(clientOptions);
        result = await client.action(action, args);
      } catch (error) {
        console.error(`Hit error while running \`auth:signIn\`:`);
        console.error(error);
        logVerbose(`Clearing auth cookies`, verbose);
        const response = json(null);
        setAuthCookies(response, null, null);
        return response;
      }

      if (result.redirect !== undefined) {
        const { redirect } = result;
        const response = json({ redirect });
        if (result.verifier) {
          response.headers.append(
            "set-cookie",
            cookie.serialize("verifier", result.verifier, {
              ...cookieConfig,
              maxAge: cookieConfig?.maxAge,
            }),
          );
        }
        logVerbose(`Redirecting to ${redirect}`, verbose);
        return response;
      } else if (result.tokens !== undefined) {
        // The server doesn't share the refresh token with the client
        // for added security - the client has to use the server
        // endpoint to refresh the token
        logVerbose(
          result.tokens === null
            ? `No tokens returned, clearing auth cookies`
            : `Setting auth cookies with returned tokens`,
          verbose,
        );

        const response = json({
          tokens:
            result.tokens !== null
              ? { token: result.tokens.token, refreshToken: "dummy" }
              : null,
        });

        if (result.tokens !== null) {
          setAuthCookies(
            response,
            result.tokens.token,
            result.tokens.refreshToken,
          );
        } else {
          setAuthCookies(response, null, null);
        }

        return response;
      }
      return json(result);
    } else {
      // Handle signOut
      try {
        const client = setupClient({
          url: convexUrl,
          token,
        });
        await client.action(action, args);
      } catch (error) {
        console.error(`Hit error while running \`auth:signOut\`:`);
        console.error(error);
      }

      logVerbose(`Clearing auth cookies`, verbose);
      const response = json(null);
      setAuthCookies(response, null, null);
      return response;
    }
  }

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
  event: RequestEvent,
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
  resolve: (event: RequestEvent) => Response | Promise<Response>;
}

/**
 * Create server hooks for SvelteKit
 * Use this in your hooks.server.ts file
 */
export function createConvexAuthHooks({
  convexUrl = getConvexUrl(),
  apiRoute = "/api/auth",
  cookieConfig,
  verbose = false,
}: ConvexAuthHooksOptions = {}) {
  const handlers = createConvexAuthHandlers({
    convexUrl,
    cookieConfig,
    verbose,
  });

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
      const result = await handlers.proxyAuthActionToConvex(event);
      return result;
    }
    logVerbose(
      `Not proxying auth action to Convex, path ${event.url.pathname} does not match ${apiRoute}`,
      verbose,
    );

    // For other routes, just continue
    return resolve(event);
  }

  return {
    ...handlers,
    handleAuth,
  };
}
