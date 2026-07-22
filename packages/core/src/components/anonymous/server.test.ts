import { beforeEach, describe, expect, test, vi } from "vitest";
import type { TokenBundle } from "../../lib/types";
import { AUTH_JWT_COOKIE, AUTH_REFRESH_COOKIE } from "../../server/cookies";
import { setupConvexAuthServer } from "../../server/setup";
import { anonymous } from "./server";

const { signInMutationMock } = vi.hoisted(() => ({
  signInMutationMock: vi.fn(),
}));
vi.mock("convex/browser", () => ({
  ConvexHttpClient: class {
    mutation = signInMutationMock;
  },
}));

const bundle: TokenBundle = {
  accessToken: "access-1",
  accessTokenExpiresAt: 1_000,
  refreshToken: "refresh-1",
  refreshTokenExpiresAt: 2_000,
  userId: "user-1",
};

const fnRef = {} as never;

const signInHandler = (secure: boolean) =>
  setupConvexAuthServer({
    convexUrl: "https://x.convex.cloud",
    refreshSession: fnRef,
    signOut: fnRef,
    cookieOptions: { secure },
  }).signInHandler(anonymous(fnRef));

beforeEach(() => signInMutationMock.mockReset());

describe("anonymous sign-in via signInHandler", () => {
  test("mints server-side, adds refresh token to cookie, returns SlimTokenBundle", async () => {
    signInMutationMock.mockResolvedValue(bundle);
    const handler = signInHandler(true);

    const res = await handler(
      new Request("https://app.test/auth/signin/anonymous", { method: "POST" }),
    );
    const body = await res.json();

    // The response is a SlimTokenBundle with the access token.
    expect(body.tokens).toEqual({
      accessToken: "access-1",
      accessTokenExpiresAt: 1_000,
      userId: "user-1",
    });
    expect(body.tokens).not.toHaveProperty("refreshToken");
    expect(signInMutationMock).toHaveBeenCalledWith(fnRef, {});

    // The refresh token lives only in an httpOnly cookie.
    const setCookies = res.headers.getSetCookie();
    const jwt = setCookies.find((c) => c.startsWith(`${AUTH_JWT_COOKIE}=`));
    const refresh = setCookies.find((c) =>
      c.startsWith(`${AUTH_REFRESH_COOKIE}=`),
    );
    expect(refresh).toContain("refresh-1");
    expect(refresh).toContain("HttpOnly");
    // `secure: true` reaches the cookies the handler writes.
    expect(jwt).toContain("Secure");
    expect(refresh).toContain("Secure");
    // The JWT access token is also in an httpOnly cookie (for SSR host usage)
    expect(jwt).toContain("access-1");
    expect(jwt).toContain("HttpOnly");
  });

  test("omits Secure when secure is false", async () => {
    signInMutationMock.mockResolvedValue(bundle);
    const handler = signInHandler(false);

    const res = await handler(
      new Request("https://app.test/auth/signin/anonymous", { method: "POST" }),
    );
    const setCookies = res.headers.getSetCookie();
    expect(setCookies.every((c) => !c.includes("Secure"))).toBe(true);
  });
});
