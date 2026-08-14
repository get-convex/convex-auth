// @vitest-environment edge-runtime
import { NextRequest } from "next/server";
import { beforeEach, expect, test, vi } from "vitest";

const fetchAction = vi.fn();

vi.mock("convex/nextjs", () => ({
  fetchAction: (...args: any[]) => fetchAction(...args),
}));

let requestCookies: Record<string, string> = {};

vi.mock("next/headers", () => ({
  headers: () => new Headers({ Host: "localhost:3000" }),
  cookies: () => ({
    get: (name: string) =>
      name in requestCookies
        ? { name, value: requestCookies[name] }
        : undefined,
    set: () => {},
    delete: () => {},
  }),
}));

const { handleAuthenticationInRequest } = await import(
  "../src/nextjs/server/request"
);

/**
 * A token that is close enough to expiry that the middleware refreshes it.
 */
function expiringToken() {
  const nowSeconds = Math.floor(Date.now() / 1000);
  const payload = { iat: nowSeconds - 3600, exp: nowSeconds + 5 };
  const encode = (value: object) =>
    btoa(JSON.stringify(value))
      .replace(/\+/g, "-")
      .replace(/\//g, "_")
      .replace(/=+$/, "");
  return `${encode({ alg: "RS256" })}.${encode(payload)}.signature`;
}

beforeEach(() => {
  fetchAction.mockReset();
  requestCookies = {
    __convexAuthJWT: expiringToken(),
    __convexAuthRefreshToken: "refresh-token",
  };
});

function request() {
  return new NextRequest("http://localhost:3000/");
}

test("a failed token refresh request leaves the session alone", async () => {
  fetchAction.mockRejectedValue(new Error("fetch failed"));
  vi.spyOn(console, "error").mockImplementation(() => {});

  const result = await handleAuthenticationInRequest(request(), {});

  // `undefined` means "nothing to do this request", so the caller leaves the
  // cookies untouched and the next request retries. `null` would delete them.
  expect(result).toEqual({ kind: "refreshTokens", refreshTokens: undefined });
});

test("a refresh token the server rejects still clears the session", async () => {
  fetchAction.mockResolvedValue({ tokens: null });

  const result = await handleAuthenticationInRequest(request(), {});

  expect(result).toEqual({ kind: "refreshTokens", refreshTokens: null });
});

test("a successful token refresh returns the new tokens", async () => {
  const tokens = { token: "new-token", refreshToken: "new-refresh-token" };
  fetchAction.mockResolvedValue({ tokens });

  const result = await handleAuthenticationInRequest(request(), {});

  expect(result).toEqual({ kind: "refreshTokens", refreshTokens: tokens });
});
