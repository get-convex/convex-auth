import { fetchAction } from "convex/nextjs";
import { jwtDecode } from "jwt-decode";
import { NextRequest, NextResponse } from "next/server";
import { SignInAction } from "../../server/implementation/index.js";
import { getRequestCookies, getRequestCookiesInMiddleware } from "./cookies.js";
import {
  getConvexNextjsOptions,
  isCorsRequest,
  logVerbose,
  setAuthCookies,
} from "./utils.js";
import type { ConvexAuthNextjsMiddlewareOptions } from "./index.js";

export async function handleAuthenticationInRequest(
  request: NextRequest,
  options: ConvexAuthNextjsMiddlewareOptions,
): Promise<
  | { kind: "redirect"; response: NextResponse }
  | {
      kind: "refreshTokens";
      refreshTokens: { token: string; refreshToken: string } | null | undefined;
    }
> {
  const verbose = options.verbose ?? false;
  const cookieConfig = options.cookieConfig ?? { maxAge: null };
  logVerbose(`Begin handleAuthenticationInRequest`, verbose);
  const requestUrl = new URL(request.url);

  // Validate CORS
  await validateCors(request);

  // Refresh tokens if necessary
  const refreshTokens = await getRefreshedTokens(options);

  // Handle code exchange for OAuth and magic links via server-side redirect
  const code = requestUrl.searchParams.get("code");
  if (
    code &&
    request.method === "GET" &&
    request.headers.get("accept")?.includes("text/html") &&
    (options.shouldHandleCode === undefined ||
      (typeof options.shouldHandleCode === "function"
        ? await options.shouldHandleCode(request)
        : options.shouldHandleCode))
  ) {
    logVerbose(`Handling code exchange for OAuth or magic link`, verbose);
    const verifier = (await getRequestCookies()).verifier ?? undefined;
    const redirectUrl = new URL(requestUrl);
    redirectUrl.searchParams.delete("code");
    try {
      const result = await fetchAction(
        "auth:signIn" as unknown as SignInAction,
        { params: { code }, verifier },
        getConvexNextjsOptions(options),
      );
      if (result.tokens === undefined) {
        throw new Error("Invalid `signIn` action result for code exchange");
      }
      const response = NextResponse.redirect(redirectUrl);
      await setAuthCookies(response, result.tokens, cookieConfig);
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
      const response = NextResponse.redirect(redirectUrl);
      await setAuthCookies(response, null, cookieConfig);
      return { kind: "redirect", response };
    }
  }

  return { kind: "refreshTokens", refreshTokens };
}

// If this is a cross-origin request with `Origin` header set
// do not allow the app to read auth cookies.
async function validateCors(request: NextRequest) {
  if (isCorsRequest(request)) {
    const cookies = await getRequestCookiesInMiddleware(request);
    cookies.token = null;
    cookies.refreshToken = null;
    cookies.verifier = null;
  }
}

const REQUIRED_TOKEN_LIFETIME_MS = 60_000; // 1 minute
const MINIMUM_REQUIRED_TOKEN_LIFETIME_MS = 10_000; // 10 seconds

async function getRefreshedTokens(options: ConvexAuthNextjsMiddlewareOptions) {
  const verbose = options.verbose ?? false;
  const cookies = await getRequestCookies();
  const { token, refreshToken } = cookies;
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
    const result = await fetchAction(
      "auth:signIn" as unknown as SignInAction,
      {
        refreshToken,
      },
      getConvexNextjsOptions(options),
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
