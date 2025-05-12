import { RequestEvent } from "@sveltejs/kit";
import { json } from "@sveltejs/kit";
import { SignInAction } from "@convex-dev/auth/server";
import { 
  AUTH_TOKEN_COOKIE, 
  AUTH_REFRESH_TOKEN_COOKIE, 
  AUTH_VERIFIER_COOKIE,
  setAuthCookies,
  setVerifierCookie,
  defaultCookieOptions
} from "./cookies.js";
import { 
  getConvexUrl,
  isCorsRequest, 
  logVerbose, 
  setupClient 
} from "./utils.js";

export function shouldProxyAuthAction(event: RequestEvent, apiRoute: string) {
  // Handle both with and without trailing slash since this could be configured either way.
  // https://nextjs.org/docs/app/api-reference/next-config-js/trailingSlash
  const requestUrl = event.url;
  if (apiRoute.endsWith("/")) {
    return (
      requestUrl.pathname === apiRoute ||
      requestUrl.pathname === apiRoute.slice(0, -1)
    );
  } else {
    return (
      requestUrl.pathname === apiRoute || requestUrl.pathname === apiRoute + "/"
    );
  }
}

/**
 * Proxy an auth action to Convex
 * Used to forward authentication requests to Convex
 */
export async function proxyAuthActionToConvex(
  event: RequestEvent,
  convexUrl = getConvexUrl(),
  cookieConfig = defaultCookieOptions,
  verbose = false
) {
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
