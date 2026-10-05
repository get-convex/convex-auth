// @vitest-environment jsdom
import { cleanup, render, waitFor } from "@testing-library/react";
import { ConvexReactClient } from "convex/react";
import { makeFunctionReference } from "convex/server";
import { afterEach, describe, expect, test, vi } from "vitest";
import { InMemoryStorage, JWT_STORAGE_KEY } from "../browser/storage.ts";
import type { SlimTokenBundle } from "../lib/types.ts";
import { ConvexAuthNextjsProvider, createNextjsAuthClient } from "./index.tsx";

const URL = "https://happy-animal-123.convex.cloud";
// Matches NamespacedStorage's `replace(/[^a-zA-Z0-9]/g, "")`.
const SUFFIX = "httpshappyanimal123convexcloud";

const SIGN_IN = makeFunctionReference<"mutation">("auth:signInWithPassword");

function slim(n: number): SlimTokenBundle {
  return { accessToken: `access-${n}`, accessTokenExpiresAt: 0, userId: "u" };
}

/**
 * Stub `fetch`. The auth routes answer with `routeBody`, and the sign-in
 * proxy answers in the Convex HTTP format with `proxyValue`.
 */
function stubFetch({
  routeBody = { tokens: null } as unknown,
  proxyValue = null as unknown,
} = {}) {
  const fetchMock = vi.fn(async (url: string, _init: RequestInit) => {
    const body = url.includes("?path=")
      ? { status: "success", value: proxyValue, logLines: [] }
      : routeBody;
    return new Response(JSON.stringify(body), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  });
  vi.stubGlobal("fetch", fetchMock);
  /** The URL, headers, and decoded body of each request. */
  const requests = () =>
    fetchMock.mock.calls.map(([url, init]) => ({
      url,
      method: init.method,
      headers: init.headers as Record<string, string>,
      body: JSON.parse(init.body as string) as Record<string, unknown>,
    }));
  return { fetchMock, requests };
}

function makeAuth(
  options: Partial<Parameters<typeof createNextjsAuthClient>[0]> = {},
) {
  const storage = new InMemoryStorage();
  const auth = createNextjsAuthClient({ url: URL, storage, ...options });
  return { auth, storage };
}

describe("createNextjsAuthClient", () => {
  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  test("refresh posts to the refresh route and adopts the token", async () => {
    const { requests } = stubFetch({ routeBody: { tokens: slim(2) } });
    const { auth } = makeAuth();
    await auth.init();
    await auth.setSession(slim(1));

    const token = await auth.fetchAccessToken({ forceRefreshToken: true });

    expect(token).toBe("access-2");
    expect(requests()).toEqual([
      expect.objectContaining({ url: "/auth/refresh", method: "POST" }),
    ]);
  });

  test("signOut posts to the sign-out route", async () => {
    const { requests } = stubFetch();
    const { auth } = makeAuth();
    await auth.init();
    await auth.setSession(slim(1));

    await auth.signOut();

    expect(requests()).toEqual([
      expect.objectContaining({ url: "/auth/signout", method: "POST" }),
    ]);
    expect(auth.getSnapshot().isAuthenticated).toBe(false);
  });

  test("the sign-in API posts to the sign-in route's proxy path", async () => {
    const { requests } = stubFetch({ proxyValue: "result" });
    const { auth } = makeAuth();

    await expect(
      auth.signIn.mutation(SIGN_IN, { username: "alice" }),
    ).resolves.toBe("result");

    const [request] = requests();
    expect(request.url).toBe("/auth/signin?path=/api/mutation");
    expect(request.body).toMatchObject({
      path: "auth:signInWithPassword",
      args: [{ username: "alice" }],
    });
    // Signed out, so no token is sent.
    expect(request.headers.Authorization).toBeUndefined();
  });

  test("each sign-in call sends the current access token", async () => {
    const { requests } = stubFetch({ proxyValue: null });
    const { auth } = makeAuth();
    await auth.init();
    await auth.setSession(slim(1));

    await auth.signIn.mutation(SIGN_IN, {});
    await auth.setSession(slim(2));
    await auth.signIn.mutation(SIGN_IN, {});
    await auth.signOut();
    await auth.signIn.mutation(SIGN_IN, {});

    const proxyRequests = requests().filter((r) => r.url.includes("?path="));
    expect(proxyRequests.map((r) => r.headers.Authorization)).toEqual([
      "Bearer access-1",
      "Bearer access-2",
      undefined,
    ]);
  });

  test("custom routes replace the defaults", async () => {
    const { requests } = stubFetch({ routeBody: { tokens: slim(2) } });
    const { auth } = makeAuth({
      refreshRoute: "/api/auth/refresh",
      signOutRoute: "/api/auth/signout",
      signInRoute: "/api/auth/signin",
    });
    await auth.init();
    await auth.setSession(slim(1));

    await auth.fetchAccessToken({ forceRefreshToken: true });
    await auth.signIn.mutation(SIGN_IN, {});
    await auth.signOut();

    expect(requests().map((r) => r.url)).toEqual([
      "/api/auth/refresh",
      "/api/auth/signin?path=/api/mutation",
      "/api/auth/signout",
    ]);
  });

  test("storageNamespace defaults to the url", async () => {
    stubFetch();
    const { auth, storage } = makeAuth();
    await auth.init();
    await auth.setSession(slim(1));

    expect(storage.getItem(`${JWT_STORAGE_KEY}_${SUFFIX}`)).toBe("access-1");
  });
});

describe("ConvexAuthNextjsProvider", () => {
  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  test("stores initialToken and keeps the proxy sign-in API", async () => {
    const { requests } = stubFetch({ proxyValue: "result" });
    const { auth, storage } = makeAuth();
    const setSignInApi = vi.spyOn(auth, "setSignInApi");
    // A real client that never connects: nothing here subscribes, and auth
    // is set only once the token is known.
    const client = new ConvexReactClient(URL);
    vi.spyOn(client, "setAuth").mockImplementation(() => {});

    render(
      <ConvexAuthNextjsProvider
        client={client}
        auth={auth}
        initialToken="access-ssr"
      >
        <div />
      </ConvexAuthNextjsProvider>,
    );

    await waitFor(() => expect(auth.getSnapshot().token).toBe("access-ssr"));
    expect(storage.getItem(`${JWT_STORAGE_KEY}_${SUFFIX}`)).toBe("access-ssr");
    expect(setSignInApi).not.toHaveBeenCalled();
    await auth.signIn.mutation(SIGN_IN, {});
    expect(requests()[0].url).toBe("/auth/signin?path=/api/mutation");
  });
});
