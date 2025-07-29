import { NextRequest, NextResponse } from "next/server";
import {
  getRequestCookiesInMiddleware,
  getResponseCookies,
} from "./cookies.js";
import { NextjsOptions } from "convex/nextjs";

export function jsonResponse(body: any, status = 200) {
  return new NextResponse(JSON.stringify(body), {
    headers: { "Content-Type": "application/json" },
    status,
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
/**
 * @param options - a subset of ConvexAuthNextjsMiddlewareOptions
 * @returns NextjsOptions
 */
export function getConvexNextjsOptions(options: {
  convexUrl?: string;
}): NextjsOptions {
  // If `convexUrl` is provided (even if it's undefined), pass it as the `url` option.
  // `convex/nextjs` has its own logic for falling back to `process.env.NEXT_PUBLIC_CONVEX_URL`
  // and protecting against accidentally passing in `undefined` (e.g. { convexUrl: process.env.VAR_I_DIDNT_SET })
  if (Object.hasOwn(options, "convexUrl")) {
    return {
      url: options.convexUrl,
    };
  }
  return {};
}
