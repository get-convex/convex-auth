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

// Same-origin by default: the CSRF guard refuses any request whose Origin
// doesn't match the Host, so a matching pair is the precondition for reaching
// the sign-in logic under test.
const signInRequest = (headers?: Record<string, string>) =>
  new Request("https://app.test/auth/signin/anonymous", {
    method: "POST",
    headers: { origin: "https://app.test", host: "app.test", ...headers },
  });

beforeEach(() => signInMutationMock.mockReset());

describe("anonymous sign-in via signInHandler", () => {
  test("mints server-side, adds refresh token to cookie, returns SlimTokenBundle", async () => {
    signInMutationMock.mockResolvedValue(bundle);
    const handler = signInHandler(true);

    const res = await handler(signInRequest());
    expect(res.status).toBe(200);
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

    const res = await handler(signInRequest());
    expect(res.status).toBe(200);
    const setCookies = res.headers.getSetCookie();
    expect(setCookies.length).toBeGreaterThan(0);
    expect(setCookies.every((c) => !c.includes("Secure"))).toBe(true);
  });

  // Login CSRF: a cross-site POST must not mint a session, or the response's
  // Set-Cookie would store the attacker's session in the victim's browser.
  test("refuses a cross-site request without signing in", async () => {
    const handler = signInHandler(true);

    const res = await handler(signInRequest({ origin: "https://evil.test" }));
    expect(res.status).toBe(403);
    expect((await res.json()).tokens).toBeNull();
    expect(signInMutationMock).not.toHaveBeenCalled();
    expect(res.headers.getSetCookie()).toEqual([]);
  });
});
