import { cookies, headers } from "next/headers";
import { NextResponse } from "next/server";

export function getRequestCookies() {
  return getCookieStore(headers(), cookies());
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
  cookies: NextResponse["cookies"],
): {
  token: string | null;
  refreshToken: string | null;
  verifier: string | null;
};
function getCookieStore(
  requestHeaders: ReturnType<typeof headers>,
  responseCookies: NextResponse["cookies"],
) {
  const isLocalhost = /localhost:\d+/.test(requestHeaders.get("Host") ?? "");
  const prefix = isLocalhost ? "" : "__Host-";
  const tokenName = prefix + "__convexAuthJWT";
  const refreshTokenName = prefix + "__convexAuthRefreshToken";
  const verifierName = prefix + "__convexAuthOAuthVerifier";
  function getValue(name: string) {
    return responseCookies.get(name)?.value ?? null;
  }
  function setValue(name: string, value: string | null) {
    if (value === null) {
      responseCookies.delete(name);
    } else {
      responseCookies.set(name, value, COOKIE_OPTIONS);
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

const COOKIE_OPTIONS = {
  secure: true,
  httpOnly: true,
  sameSite: "lax",
  path: "/",
} as const;
