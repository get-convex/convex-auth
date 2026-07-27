import { beforeEach, describe, expect, test, vi } from "vitest";
import type { TokenBundle } from "../../lib/types";
import { AUTH_JWT_COOKIE, AUTH_REFRESH_COOKIE } from "../../server/cookies";
import { setupConvexAuthServer } from "../../server/setup";
import { passwordSignIn, passwordSignUp } from "./server";

const { actionMock } = vi.hoisted(() => ({
  actionMock: vi.fn(),
}));
vi.mock("convex/browser", () => ({
  ConvexHttpClient: class {
    action = actionMock;
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

const server = setupConvexAuthServer({
  convexUrl: "https://x.convex.cloud",
  refreshSession: fnRef,
  signOut: fnRef,
  cookieOptions: { secure: true },
});

// Same-origin by default: the CSRF guard refuses any request whose Origin
// doesn't match the Host, so a matching pair is the precondition for reaching
// the sign-in logic under test.
const credentialsRequest = (route: string, body?: BodyInit) =>
  new Request(`https://app.test${route}`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      origin: "https://app.test",
      host: "app.test",
    },
    body: body ?? JSON.stringify({ username: "Alice", password: "hunter22" }),
  });

beforeEach(() => actionMock.mockReset());

describe("password sign-in via signInHandler", () => {
  test("runs the action server-side, adds refresh token to cookie, returns SlimTokenBundle", async () => {
    actionMock.mockResolvedValue({ success: true, tokens: bundle });
    const handler = server.signInHandler(passwordSignIn(fnRef));

    const res = await handler(credentialsRequest("/auth/signin/password"));
    expect(res.status).toBe(200);
    const body = await res.json();

    // The credentials off the JSON body reach the action.
    expect(actionMock).toHaveBeenCalledWith(fnRef, {
      username: "Alice",
      password: "hunter22",
    });

    // The response is a SlimTokenBundle with the access token.
    expect(body.tokens).toEqual({
      accessToken: "access-1",
      accessTokenExpiresAt: 1_000,
      userId: "user-1",
    });
    expect(body.tokens).not.toHaveProperty("refreshToken");

    // The refresh token lives only in an httpOnly cookie.
    const setCookies = res.headers.getSetCookie();
    const jwt = setCookies.find((c) => c.startsWith(`${AUTH_JWT_COOKIE}=`));
    const refresh = setCookies.find((c) =>
      c.startsWith(`${AUTH_REFRESH_COOKIE}=`),
    );
    expect(refresh).toContain("refresh-1");
    expect(refresh).toContain("HttpOnly");
    expect(jwt).toContain("access-1");
    expect(jwt).toContain("HttpOnly");
  });

  test("echoes the action's userError on failure and writes no cookies", async () => {
    actionMock.mockResolvedValue({
      success: false,
      userError: { error: "INVALID_CREDENTIALS" },
    });
    const handler = server.signInHandler(passwordSignIn(fnRef));

    const res = await handler(credentialsRequest("/auth/signin/password"));
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body).toEqual({
      tokens: null,
      userError: { error: "INVALID_CREDENTIALS" },
    });
    expect(res.headers.getSetCookie()).toEqual([]);
  });

  test.each([
    ["not JSON", "not json"],
    ["missing password", JSON.stringify({ username: "Alice" })],
    [
      "non-string credentials",
      JSON.stringify({ username: "Alice", password: 42 }),
    ],
  ])(
    "replies 400 to a malformed body (%s) without running the action",
    async (_name, body) => {
      const handler = server.signInHandler(passwordSignIn(fnRef));

      const res = await handler(
        credentialsRequest("/auth/signin/password", body),
      );

      expect(res.status).toBe(400);
      expect(await res.json()).toEqual({ tokens: null });
      expect(actionMock).not.toHaveBeenCalled();
    },
  );
});

describe("password sign-up via signInHandler", () => {
  test("mints a session for a new account", async () => {
    actionMock.mockResolvedValue({ success: true, tokens: bundle });
    const handler = server.signInHandler(passwordSignUp(fnRef));

    const res = await handler(credentialsRequest("/auth/signup/password"));
    expect(res.status).toBe(200);
    const body = await res.json();

    expect(actionMock).toHaveBeenCalledWith(fnRef, {
      username: "Alice",
      password: "hunter22",
    });
    expect(body.tokens).toMatchObject({ accessToken: "access-1" });
    const refresh = res.headers
      .getSetCookie()
      .find((c) => c.startsWith(`${AUTH_REFRESH_COOKIE}=`));
    expect(refresh).toContain("refresh-1");
  });

  test("echoes USERNAME_TAKEN on failure", async () => {
    actionMock.mockResolvedValue({
      success: false,
      userError: { error: "USERNAME_TAKEN" },
    });
    const handler = server.signInHandler(passwordSignUp(fnRef));

    const res = await handler(credentialsRequest("/auth/signup/password"));

    expect(await res.json()).toEqual({
      tokens: null,
      userError: { error: "USERNAME_TAKEN" },
    });
    expect(res.headers.getSetCookie()).toEqual([]);
  });
});
