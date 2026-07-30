import { beforeEach, describe, expect, test, vi } from "vitest";
import { anonymousRoutes } from "../components/anonymous/server";
import { passwordRoutes } from "../components/password/server";
import type { TokenBundle } from "../lib/types";
import { AUTH_REFRESH_COOKIE } from "./cookies";
import { setupConvexAuthServer } from "./setup";

// Stub the Convex client so the tests exercise routing and cookie behavior
// without a backend.
const { mutationMock, actionMock } = vi.hoisted(() => ({
  mutationMock: vi.fn(),
  actionMock: vi.fn(),
}));
vi.mock("convex/browser", () => ({
  ConvexHttpClient: class {
    mutation = mutationMock;
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

function setup(config?: { basePath?: string }) {
  return setupConvexAuthServer({
    convexUrl: "https://x.convex.cloud",
    refreshSession: fnRef,
    signOut: fnRef,
    cookieOptions: { secure: false },
    providers: [
      passwordRoutes({ signIn: fnRef, signUp: fnRef }),
      anonymousRoutes(fnRef),
    ],
    ...config,
  });
}

// Same-origin by default, so requests pass the CSRF guard and reach the
// dispatch logic under test.
const request = (path: string, init?: RequestInit) =>
  new Request(`https://app.test${path}`, {
    method: "POST",
    headers: { origin: "https://app.test", host: "app.test" },
    ...init,
  });

beforeEach(() => {
  mutationMock.mockReset();
  actionMock.mockReset();
});

describe("the catch-all handler", () => {
  test("serves refresh at its conventional path", async () => {
    mutationMock.mockResolvedValue(bundle);
    const res = await setup().handler(
      request("/auth/refresh", {
        headers: {
          origin: "https://app.test",
          host: "app.test",
          cookie: `${AUTH_REFRESH_COOKIE}=refresh-0`,
        },
      }),
    );
    expect(res.status).toBe(200);
    expect((await res.json()).tokens.accessToken).toBe("access-1");
    expect(mutationMock).toHaveBeenCalledWith(fnRef, {
      refreshToken: "refresh-0",
    });
  });

  test("serves sign-out at its conventional path", async () => {
    const res = await setup().handler(request("/auth/signout"));
    expect(res.status).toBe(200);
    expect((await res.json()).tokens).toBeNull();
  });

  test("serves a provider's sign-in routes", async () => {
    mutationMock.mockResolvedValue(bundle);
    const res = await setup().handler(request("/auth/signin/anonymous"));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.tokens.accessToken).toBe("access-1");
    expect(body.tokens).not.toHaveProperty("refreshToken");
  });

  test("serves both password flows", async () => {
    actionMock.mockResolvedValue({ success: true, tokens: bundle });
    const auth = setup();
    const credentials = {
      body: JSON.stringify({ username: "u", password: "p" }),
      headers: {
        origin: "https://app.test",
        host: "app.test",
        "content-type": "application/json",
      },
    };
    for (const path of ["/auth/signin/password", "/auth/signup/password"]) {
      const res = await auth.handler(request(path, credentials));
      expect(res.status).toBe(200);
      expect((await res.json()).tokens.accessToken).toBe("access-1");
    }
    expect(actionMock).toHaveBeenCalledTimes(2);
  });

  test("replies 404 for an unknown subpath and outside the base path", async () => {
    const auth = setup();
    for (const path of ["/auth/nope", "/other/refresh", "/auth"]) {
      const res = await auth.handler(request(path));
      expect(res.status).toBe(404);
      expect((await res.json()).tokens).toBeNull();
    }
    expect(mutationMock).not.toHaveBeenCalled();
  });

  test("replies 405 to non-POST methods on a known route", async () => {
    const res = await setup().handler(
      request("/auth/refresh", { method: "GET" }),
    );
    expect(res.status).toBe(405);
    expect(res.headers.get("allow")).toBe("POST");
    expect(mutationMock).not.toHaveBeenCalled();
  });

  test("honors a custom basePath", async () => {
    mutationMock.mockResolvedValue(bundle);
    const auth = setup({ basePath: "/api/auth" });
    const res = await auth.handler(request("/api/auth/signin/anonymous"));
    expect(res.status).toBe(200);
    expect((await auth.handler(request("/auth/signin/anonymous"))).status).toBe(
      404,
    );
  });

  test("rejects duplicate routes at setup time", () => {
    expect(() =>
      setupConvexAuthServer({
        convexUrl: "https://x.convex.cloud",
        refreshSession: fnRef,
        signOut: fnRef,
        cookieOptions: { secure: false },
        providers: [anonymousRoutes(fnRef), anonymousRoutes(fnRef)],
      }),
    ).toThrow('Duplicate auth route "signin/anonymous"');
    // The built-in session routes are reserved too.
    expect(() =>
      setupConvexAuthServer({
        convexUrl: "https://x.convex.cloud",
        refreshSession: fnRef,
        signOut: fnRef,
        cookieOptions: { secure: false },
        providers: [{ refresh: { run: async () => ({ tokens: bundle }) } }],
      }),
    ).toThrow('Duplicate auth route "refresh"');
  });
});
