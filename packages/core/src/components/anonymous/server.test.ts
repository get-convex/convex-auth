import { beforeEach, describe, expect, test, vi } from "vitest";
import type { TokenBundle } from "../../lib/types";
import { AUTH_JWT_COOKIE, AUTH_REFRESH_COOKIE } from "../../server/cookies";
import { anonymousSignInHandler } from "./server";

const { mutationMock } = vi.hoisted(() => ({ mutationMock: vi.fn() }));
vi.mock("convex/browser", () => ({
  ConvexHttpClient: class {
    mutation = mutationMock;
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

beforeEach(() => mutationMock.mockReset());

describe("anonymousSignInHandler", () => {
  test("mints server-side, cookies the refresh token, returns access-only", async () => {
    mutationMock.mockResolvedValue(bundle);
    const handler = anonymousSignInHandler({
      convexUrl: "https://x.convex.cloud",
      signIn: fnRef,
    });

    const res = await handler(
      new Request("https://app.test/auth/signin/anonymous", { method: "POST" }),
    );
    const body = await res.json();

    // The browser only ever sees the access-only bundle.
    expect(body.tokens).toEqual({
      accessToken: "access-1",
      accessTokenExpiresAt: 1_000,
      userId: "user-1",
    });
    expect(body.tokens).not.toHaveProperty("refreshToken");
    expect(mutationMock).toHaveBeenCalledWith(fnRef, {});

    // The refresh token lives only in an httpOnly cookie.
    const setCookies = res.headers.getSetCookie();
    const jwt = setCookies.find((c) => c.startsWith(`${AUTH_JWT_COOKIE}=`));
    const refresh = setCookies.find((c) =>
      c.startsWith(`${AUTH_REFRESH_COOKIE}=`),
    );
    expect(jwt).toContain("access-1");
    expect(refresh).toContain("refresh-1");
    expect(refresh).toContain("HttpOnly");
  });
});
