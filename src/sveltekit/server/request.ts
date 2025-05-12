import { jwtDecode } from "jwt-decode";
import { SignInAction } from "../../server/implementation/index.js";
import type { ConvexAuthHooksOptions } from "./index.js";
import { isCorsRequest, logVerbose, setupClient } from "./utils.js";
import { RequestEvent } from "@sveltejs/kit";
import { 
  AUTH_TOKEN_COOKIE, 
  AUTH_REFRESH_TOKEN_COOKIE, 
  AUTH_VERIFIER_COOKIE,
  setAuthCookies
} from "./cookies.js";

export async function handleAuthenticationInRequest(
  event: RequestEvent,
  options: ConvexAuthHooksOptions,
): Promise<
  | { kind: "redirect"; response: Response }
  | {
      kind: "refreshTokens";
      refreshTokens: { token: string; refreshToken: string } | null | undefined;
    }
> {
  const { request } = event;
  const verbose = options.verbose ?? false;
  const cookieConfig = options.cookieConfig ?? { maxAge: null };
  
  logVerbose(`Begin handleAuthenticationInRequest`, verbose);
  const requestUrl = new URL(request.url);

  // Validate CORS
  validateCors(event);

  // Refresh tokens if necessary
  const refreshTokens = await getRefreshedTokens(event, options);

  // Handle code exchange for OAuth and magic links via server-side redirect
  const code = requestUrl.searchParams.get("code");
  if (
    code &&
    request.method === "GET" &&
    request.headers.get("accept")?.includes("text/html")
  ) {
    logVerbose(`Handling code exchange for OAuth or magic link`, verbose);
    const verifier = event.cookies.get(AUTH_VERIFIER_COOKIE) || undefined;
    const redirectUrl = new URL(requestUrl);
    redirectUrl.searchParams.delete("code");
    try {
      const client = setupClient({ url: options.convexUrl });
      const result = await client.action(
        "auth:signIn" as unknown as SignInAction,
        { params: { code }, verifier },
      );
      if (result.tokens === undefined) {
        throw new Error("Invalid `signIn` action result for code exchange");
      }
      
      // Create a response using SvelteKit's Response API with proper status code and redirection
      const response = new Response(null, {
        status: 303,
        headers: { Location: redirectUrl.toString() }
      });
      
      // Set the auth cookies
      if (result.tokens) {
        setAuthCookies(response, result.tokens.token, result.tokens.refreshToken, cookieConfig, verbose);
      }
      
      logVerbose(
        `Successfully validated code, redirecting to ${redirectUrl.toString()} with auth cookies`,
        verbose,
      );
      
      return { kind: "redirect", response };
    } catch (error) {
      console.error(error);
      logVerbose(
        `Error validating code, redirecting to ${redirectUrl.toString()} and clearing auth cookies`,
        verbose,
      );
      
      // Create a response for error case
      const response = new Response(null, {
        status: 303,
        headers: { Location: redirectUrl.toString() }
      });
      
      // Clear the auth cookies
      setAuthCookies(response, null, null, cookieConfig, verbose);
      
      return { kind: "redirect", response };
    }
  }

  return { kind: "refreshTokens", refreshTokens };
}

// If this is a cross-origin request with `Origin` header set
// do not allow the app to read auth cookies.
function validateCors(event: RequestEvent) {
  if (isCorsRequest(event.request)) {
    // Clear cookies in the CORS context to prevent security issues
    event.cookies.delete(AUTH_TOKEN_COOKIE, { path: '/' });
    event.cookies.delete(AUTH_REFRESH_TOKEN_COOKIE, { path: '/' });
    event.cookies.delete(AUTH_VERIFIER_COOKIE, { path: '/' });
  }
}

const REQUIRED_TOKEN_LIFETIME_MS = 60_000; // 1 minute
const MINIMUM_REQUIRED_TOKEN_LIFETIME_MS = 10_000; // 10 seconds

async function getRefreshedTokens(event: RequestEvent, options: ConvexAuthHooksOptions) {
  const verbose = options.verbose ?? false;
  const token = event.cookies.get(AUTH_TOKEN_COOKIE) || null;
  const refreshToken = event.cookies.get(AUTH_REFRESH_TOKEN_COOKIE) || null;
  
  if (refreshToken === null && token === null) {
    logVerbose(`No tokens to refresh, returning undefined`, verbose);
    return undefined;
  }
  if (refreshToken === null || token === null) {
    logVerbose(
      `Refresh token null? ${refreshToken === null}, token null? ${token === null}, returning null`,
      verbose,
    );
    return null;
  }
  const decodedToken = decodeToken(token);
  if (decodedToken === null) {
    logVerbose(`Failed to decode token, returning null`, verbose);
    return null;
  }
  const totalTokenLifetimeMs =
    decodedToken.exp! * 1000 - decodedToken.iat! * 1000;
  // Check that the token is valid for the next 1 minute
  // or at least 10% of its valid duration or 10 seconds
  const minimumExpiration =
    Date.now() +
    Math.min(
      REQUIRED_TOKEN_LIFETIME_MS,
      Math.max(MINIMUM_REQUIRED_TOKEN_LIFETIME_MS, totalTokenLifetimeMs / 10),
    );
  if (decodedToken.exp! * 1000 > minimumExpiration) {
    logVerbose(
      `Token expires far enough in the future, no need to refresh, returning undefined`,
      verbose,
    );
    return undefined;
  }
  try {
    const client = setupClient({ url: options.convexUrl });
    const result = await client.action(
      "auth:signIn" as unknown as SignInAction,
      {
        refreshToken,
      },
    );
    if (result.tokens === undefined) {
      throw new Error("Invalid `signIn` action result for token refresh");
    }
    logVerbose(
      `Successfully refreshed tokens: is null? ${result.tokens === null}`,
      verbose,
    );
    return result.tokens;
  } catch (error) {
    console.error(error);
    logVerbose(`Failed to refresh tokens, returning null`, verbose);
    return null;
  }
}

function decodeToken(token: string) {
  try {
    return jwtDecode(token);
  } catch (e) {
    return null;
  }
}
