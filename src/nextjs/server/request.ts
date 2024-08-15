import { fetchAction } from "convex/nextjs";
import { jwtDecode } from "jwt-decode";
import { NextRequest, NextResponse } from "next/server";
import { SignInAction } from "../../server/implementation.js";
import { getRequestCookies, getRequestCookiesInMiddleware } from "./cookies.js";
import { isCorsRequest, setAuthCookies } from "./utils.js";

export async function handleAuthenticationInRequest(request: NextRequest) {
  const requestUrl = new URL(request.url);

  // Validate CORS
  validateCors(request);

  // Refresh tokens if necessary
  const refreshTokens = await getRefreshedTokens();

  // Handle code exchange for OAuth and magic links via server-side redirect
  const code = requestUrl.searchParams.get("code");
  if (
    code &&
    request.method === "GET" &&
    request.headers.get("accept")?.includes("text/html")
  ) {
    const verifier = getRequestCookies().verifier ?? undefined;
    const redirectUrl = new URL(requestUrl);
    redirectUrl.searchParams.delete("code");
    try {
      const result = await fetchAction(
        "auth:signIn" as unknown as SignInAction,
        { params: { code }, verifier },
      );
      if (result.tokens === undefined) {
        throw new Error("Invalid `signIn` action result for code exchange");
      }
      const response = NextResponse.redirect(redirectUrl);
      setAuthCookies(response, result.tokens);
      return response;
    } catch (error) {
      console.error(error);
      const response = NextResponse.redirect(redirectUrl);
      setAuthCookies(response, null);
      return NextResponse.redirect(redirectUrl);
    }
  }

  const response = NextResponse.next();
  if (refreshTokens !== undefined) {
    setAuthCookies(response, refreshTokens);
  }
  return response;
}

// If this is a cross-origin request with `Origin` header set
// do not allow the app to read auth cookies.
function validateCors(request: NextRequest) {
  if (isCorsRequest(request)) {
    const cookies = getRequestCookiesInMiddleware(request);
    cookies.token = null;
    cookies.refreshToken = null;
    cookies.verifier = null;
  }
}

const REQUIRED_TOKEN_LIFETIME_MS = 60_000; // 1 minute
const MINIMUM_REQUIRED_TOKEN_LIFETIME_MS = 10_000; // 10 seconds

async function getRefreshedTokens() {
  const cookies = getRequestCookies();
  const { token, refreshToken } = cookies;
  if (refreshToken === null && token === null) {
    return undefined;
  }
  if (refreshToken === null || token === null) {
    return null;
  }
  const decodedToken = decodeToken(token);
  if (decodedToken === null) {
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
    return undefined;
  }
  try {
    const result = await fetchAction("auth:signIn" as unknown as SignInAction, {
      refreshToken,
    });
    if (result.tokens === undefined) {
      throw new Error("Invalid `signIn` action result for token refresh");
    }
    return result.tokens;
  } catch (error) {
    console.error(error);
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
