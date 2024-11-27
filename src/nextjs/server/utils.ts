import { NextRequest, NextResponse } from "next/server";
import {
  getRequestCookiesInMiddleware,
  getResponseCookies,
} from "./cookies.js";

export function jsonResponse(body: any) {
  return new NextResponse(JSON.stringify(body), {
    headers: { "Content-Type": "application/json" },
  });
}

export async function setAuthCookies(
  response: NextResponse,
  tokens: { token: string; refreshToken: string } | null,
  cookieConfig: {
    maxAge: number | null;
  },
) {
  const responseCookies = await getResponseCookies(response, cookieConfig);
  if (tokens === null) {
    responseCookies.token = null;
    responseCookies.refreshToken = null;
  } else {
    responseCookies.token = tokens.token;
    responseCookies.refreshToken = tokens.refreshToken;
  }
  responseCookies.verifier = null;
}

/**
 * Forward on any auth cookies in the request to the next handler.
 *
 * @param request
 * @param tokens
 */
export async function setAuthCookiesInMiddleware(
  request: NextRequest,
  tokens: { token: string; refreshToken: string } | null,
) {
  const requestCookies = await getRequestCookiesInMiddleware(request);
  if (tokens === null) {
    requestCookies.token = null;
    requestCookies.refreshToken = null;
  } else {
    requestCookies.token = tokens.token;
    requestCookies.refreshToken = tokens.refreshToken;
  }
}

export function isCorsRequest(request: NextRequest) {
  const origin = request.headers.get("Origin");
  const originURL = origin ? new URL(origin) : null;
  return (
    originURL !== null &&
    (originURL.host !== request.headers.get("Host") ||
      originURL.protocol !== new URL(request.url).protocol)
  );
}

export function logVerbose(message: string, verbose: boolean) {
  if (verbose) {
    console.debug(
      `[verbose] ${new Date().toISOString()} [ConvexAuthNextjs] ${message}`,
    );
  }
}

export function getRedactedMessage(value: string) {
  const length = 5;
  if (value.length < length * 2) {
    return "<redacted>";
  }
  return (
    value.substring(0, length) +
    "<redacted>" +
    value.substring(value.length - length)
  );
}
