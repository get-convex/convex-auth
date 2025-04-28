/**
 * Server-side handlers for Convex Auth in SvelteKit
 */
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
import {
  AUTH_TOKEN_COOKIE,
  AUTH_REFRESH_TOKEN_COOKIE,
  AUTH_VERIFIER_COOKIE,
  setAuthCookies,
  setVerifierCookie,
  defaultCookieOptions,
} from "./cookies";
import { IsAuthenticatedQuery } from "../../server/implementation/index.js";
import { handleAuthenticationInRequest } from "./request.js";

/**
 * Create server-side handlers for SvelteKit
 */
export function createConvexAuthHandlers({
  convexUrl = getConvexUrl(),
  cookieConfig: cookieConfigOverride,
  verbose = false,
}: ConvexAuthHooksOptions = {}) {
  const cookieConfig = cookieConfigOverride ?? defaultCookieOptions;

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
      const verifier = event.cookies.get(AUTH_VERIFIER_COOKIE);
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
        setAuthCookies(response, null, null, cookieConfig, verbose);
        return response;
      }

      if (result.redirect !== undefined) {
        const { redirect } = result;
        const response = json({ redirect });
        if (result.verifier) {
          // Set the verifier cookie for OAuth PKCE flow
          setVerifierCookie(response, result.verifier, cookieConfig, verbose);
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
            cookieConfig,
            verbose,
          );
        } else {
          setAuthCookies(response, null, null, cookieConfig, verbose);
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
      setAuthCookies(response, null, null, cookieConfig, verbose);
      return response;
    }
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
   * Load auth state from cookies
   */
  async function loadAuthState(event: RequestEvent) {
    return getAuthState(event);
  }

  return {
    getAuthState,
    loadAuthState,
    proxyAuthActionToConvex,
    isAuthenticated,
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

    // Refresh tokens, handle code query param
    const authResult = await handleAuthenticationInRequest(event, { convexUrl, apiRoute, cookieConfig, verbose });

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
          verbose
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
