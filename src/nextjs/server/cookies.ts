import { cookies, headers } from "next/headers";
import { NextRequest, NextResponse } from "next/server";

export function getRequestCookies() {
  return getCookieStore(headers(), cookies());
}

export function getRequestCookiesInMiddleware(request: NextRequest) {
  return getCookieStore(headers(), request.cookies);
}

export function getResponseCookies(response: NextResponse) {
  return getCookieStore(headers(), response.cookies);
}

function getCookieStore(
  requestHeaders: ReturnType<typeof headers>,
  requestCookies: ReturnType<typeof cookies>,
): {
  readonly token: string | null;
  readonly refreshToken: string | null;
  readonly verifier: string | null;
};
function getCookieStore(
  headers: Headers,
  cookies: NextResponse["cookies"] | NextRequest["cookies"],
): {
  token: string | null;
  refreshToken: string | null;
  verifier: string | null;
};
function getCookieStore(
  requestHeaders: ReturnType<typeof headers>,
  responseCookies: NextResponse["cookies"] | NextRequest["cookies"],
) {
  const isLocalhost = /localhost:\d+/.test(requestHeaders.get("Host") ?? "");
  const prefix = isLocalhost ? "" : "__Host-";
  const tokenName = prefix + "__convexAuthJWT";
  const refreshTokenName = prefix + "__convexAuthRefreshToken";
  const verifierName = prefix + "__convexAuthOAuthVerifier";
  function getValue(name: string) {
    return responseCookies.get(name)?.value ?? null;
  }
  const cookieOptions = getCookieOptions(isLocalhost);
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

function getCookieOptions(isLocalhost: boolean) {
  // Safari does not send headers with `secure: true` on http:// domains including localhost,
  // so set `secure: false` (https://codedamn.com/news/web-development/safari-cookie-is-not-being-set)
  return {
    secure: isLocalhost ? false : true,
    httpOnly: true,
    sameSite: "lax",
    path: "/",
  } as const;
}
