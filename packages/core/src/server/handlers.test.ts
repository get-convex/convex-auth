import { beforeEach, describe, expect, test, vi } from "vitest";
import type { TokenBundle } from "../lib/types";
import { AUTH_JWT_COOKIE, AUTH_REFRESH_COOKIE } from "./cookies";
import { refreshHandler, signOutHandler } from "./handlers";

// The handlers talk to Convex through a `ConvexHttpClient`; stub it so the
// tests exercise cookie behavior without a backend. This mutation mock stands
// in for the refresh or sign-out mutations, depending on the test case.
const { mutationMock } = vi.hoisted(() => ({ mutationMock: vi.fn() }));
vi.mock("convex/browser", () => ({
  ConvexHttpClient: class {
    mutation = mutationMock;
  },
}));

function bundle(n: number): TokenBundle {
  return {
    accessToken: `access-${n}`,
    accessTokenExpiresAt: 1_000,
    refreshToken: `refresh-${n}`,
    refreshTokenExpiresAt: 2_000,
    userId: "user-1",
  };
}

const requestWithRefresh = (token?: string) =>
  new Request("https://app.test/auth/refresh", {
    method: "POST",
    headers: token ? { cookie: `${AUTH_REFRESH_COOKIE}=${token}` } : {},
  });

// A placeholder function reference; the mocked client ignores it.
const fnRef = {} as never;

beforeEach(() => mutationMock.mockReset());

describe("refreshHandler", () => {
  test("rotates the session and returns access-only tokens", async () => {
    // Set up the refresh mutation to return new tokens.
    mutationMock.mockResolvedValue(bundle(2));
    const handler = refreshHandler({
      convexUrl: "https://x.convex.cloud",
      refreshSession: fnRef,
      cookieOptions: { secure: false },
    });

    const res = await handler(requestWithRefresh("refresh-1"));
    const body = await res.json();

    // Access-only: no refresh token in the response body.
    expect(body.tokens).toEqual({
      accessToken: "access-2",
      accessTokenExpiresAt: 1_000,
      userId: "user-1",
    });
    expect(body.tokens).not.toHaveProperty("refreshToken");
    expect(mutationMock).toHaveBeenCalledWith(fnRef, {
      refreshToken: "refresh-1",
    });

    // Both cookies rewritten, both cookie httpOnly.
    const setCookies = res.headers.getSetCookie();
    const jwt = setCookies.find((c) => c.startsWith(`${AUTH_JWT_COOKIE}=`));
    const refresh = setCookies.find((c) =>
      c.startsWith(`${AUTH_REFRESH_COOKIE}=`),
    );
    expect(jwt).toContain("access-2");
    expect(jwt).toContain("HttpOnly");
    expect(refresh).toContain("refresh-2");
    expect(refresh).toContain("HttpOnly");
  });

  test("with no refresh cookie returns null without calling Convex", async () => {
    const handler = refreshHandler({
      convexUrl: "https://x.convex.cloud",
      refreshSession: fnRef,
      cookieOptions: { secure: false },
    });

    const res = await handler(requestWithRefresh());
    expect((await res.json()).tokens).toBeNull();
    expect(mutationMock).not.toHaveBeenCalled();
  });

  test("clears cookies when the refresh token is unknown", async () => {
    // Set up the refresh mutation to not recognize the token and to return null.
    mutationMock.mockResolvedValue(null);
    const handler = refreshHandler({
      convexUrl: "https://x.convex.cloud",
      refreshSession: fnRef,
      cookieOptions: { secure: false },
    });

    const res = await handler(requestWithRefresh("stale"));
    expect((await res.json()).tokens).toBeNull();
    const setCookies = res.headers.getSetCookie();
    expect(setCookies.some((c) => c.includes("Max-Age=0"))).toBe(true);
  });
});

describe("signOutHandler", () => {
  test("revokes and clears both cookies", async () => {
    mutationMock.mockResolvedValue(null);
    const handler = signOutHandler({
      convexUrl: "https://x.convex.cloud",
      signOut: fnRef,
      cookieOptions: { secure: false },
    });

    const res = await handler(requestWithRefresh("refresh-1"));
    expect((await res.json()).tokens).toBeNull();
    expect(mutationMock).toHaveBeenCalledWith(fnRef, {
      refreshToken: "refresh-1",
    });

    const setCookies = res.headers.getSetCookie();
    expect(
      setCookies.filter((c) => c.includes("Max-Age=0")).length,
    ).toBeGreaterThanOrEqual(2);
  });

  test("with no refresh cookie clears without calling Convex", async () => {
    const handler = signOutHandler({
      convexUrl: "https://x.convex.cloud",
      signOut: fnRef,
      cookieOptions: { secure: false },
    });

    const res = await handler(requestWithRefresh());
    expect((await res.json()).tokens).toBeNull();
    expect(mutationMock).not.toHaveBeenCalled();
    const setCookies = res.headers.getSetCookie();
    expect(
      setCookies.filter((c) => c.includes("Max-Age=0")).length,
    ).toBeGreaterThanOrEqual(2);
  });
});
