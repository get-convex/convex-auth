import { cookies, headers } from "next/headers";
import { NextRequest, NextResponse } from "next/server";
import * as utils from "../../server/utils.js";

export function getRequestCookies() {
  // maxAge doesn't matter for request cookies since they're only relevant for the
  // length of the request
  return getCookieStore(headers(), cookies(), { maxAge: null });
}

export function getRequestCookiesInMiddleware(request: NextRequest) {
  // maxAge doesn't matter for request cookies since they're only relevant for the
  // length of the request
  return getCookieStore(headers(), request.cookies, { maxAge: null });
}

export function getResponseCookies(
  response: NextResponse,
  cookieConfig: {
    maxAge: number | null;
  },
) {
  return getCookieStore(headers(), response.cookies, cookieConfig);
}

function getCookieStore(
  requestHeaders: ReturnType<typeof headers>,
  requestCookies: ReturnType<typeof cookies>,
  cookieConfig: {
    maxAge: number | null;
  },
): {
  readonly token: string | null;
  readonly refreshToken: string | null;
  readonly verifier: string | null;
};
function getCookieStore(
  headers: Headers,
  cookies: NextResponse["cookies"] | NextRequest["cookies"],
  cookieConfig: {
    maxAge: number | null;
  },
): {
  token: string | null;
  refreshToken: string | null;
  verifier: string | null;
};
function getCookieStore(
  requestHeaders: ReturnType<typeof headers>,
  responseCookies: NextResponse["cookies"] | NextRequest["cookies"],
  cookieConfig: {
    maxAge: number | null;
  },
) {
  const isLocalhost = utils.isLocalHost(
    requestHeaders.get("Host") ?? ""
  );
  const prefix = isLocalhost ? "" : "__Host-";
  const tokenName = prefix + "__convexAuthJWT";
  const refreshTokenName = prefix + "__convexAuthRefreshToken";
  const verifierName = prefix + "__convexAuthOAuthVerifier";
  function getValue(name: string) {
    return responseCookies.get(name)?.value ?? null;
  }
  const cookieOptions = getCookieOptions(isLocalhost, cookieConfig);
  function setValue(name: string, value: string | null) {
    if (value === null) {
      // Only request cookies have a `size` property
      if ("size" in responseCookies) {
        responseCookies.delete(name);
      } else {
        // See https://github.com/vercel/next.js/issues/56632
        // for why .delete({}) doesn't work:
        responseCookies.set(name, "", {
          ...cookieOptions,
          maxAge: undefined,
          expires: 0,
        });
      }
    } else {
      responseCookies.set(name, value, cookieOptions);
    }
  }
  return {
    get token() {
      return getValue(tokenName);
    },
    set token(value: string | null) {
      setValue(tokenName, value);
    },
    get refreshToken() {
      return getValue(refreshTokenName);
    },
    set refreshToken(value: string | null) {
      setValue(refreshTokenName, value);
    },
    get verifier() {
      return getValue(verifierName);
    },
    set verifier(value: string | null) {
      setValue(verifierName, value);
    },
  };
}

function getCookieOptions(
  isLocalhost: boolean,
  cookieConfig: { maxAge: number | null },
) {
  // Safari does not send headers with `secure: true` on http:// domains including localhost,
  // so set `secure: false` (https://codedamn.com/news/web-development/safari-cookie-is-not-being-set)
  return {
    secure: isLocalhost ? false : true,
    httpOnly: true,
    sameSite: "lax",
    path: "/",
    maxAge: cookieConfig.maxAge ?? undefined,
  } as const;
}
