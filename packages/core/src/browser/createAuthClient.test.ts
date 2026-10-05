// @vitest-environment node
import { makeFunctionReference } from "convex/server";
import { afterEach, describe, expect, test, vi } from "vitest";
import type { ConvexAuthApi, TokenBundle } from "../lib/types.ts";
import type { AuthSignInApi } from "./signInApi.ts";
import { createAuthClient } from "./createAuthClient.ts";
import {
  InMemoryStorage,
  JWT_STORAGE_KEY,
  NamespacedStorage,
  REFRESH_TOKEN_STORAGE_KEY,
} from "./storage.ts";

const URL = "https://happy-animal-123.convex.cloud";

const API = {
  refreshSession: makeFunctionReference<"mutation">("auth:refreshSession"),
  signOut: makeFunctionReference<"mutation">("auth:signOut"),
} as ConvexAuthApi;

function bundle(n: number): TokenBundle {
  return {
    accessToken: `access-${n}`,
    accessTokenExpiresAt: 0,
    refreshToken: `refresh-${n}`,
    refreshTokenExpiresAt: 0,
    userId: "user-1",
  };
}

/**
 * Stub `fetch` with a Convex HTTP API that answers each mutation with the
 * value `respond` returns for its path and args.
 */
function stubConvexHttp(
  respond: (path: string, args: unknown) => unknown,
  logLines: string[] = [],
) {
  const fetchMock = vi.fn(async (url: string, init: RequestInit) => {
    const body = JSON.parse(init.body as string) as {
      path: string;
      args: [unknown];
    };
    return new Response(
      JSON.stringify({
        status: "success",
        value: respond(body.path, body.args[0]) ?? null,
        logLines,
      }),
      { status: 200, headers: { "content-type": "application/json" } },
    );
  });
  vi.stubGlobal("fetch", fetchMock);
  /** The URL and decoded body of each request. */
  const requests = () =>
    fetchMock.mock.calls.map(([url, init]) => ({
      url,
      body: JSON.parse(init.body as string) as {
        path: string;
        args: unknown[];
      },
    }));
  return { fetchMock, requests };
}

describe("createAuthClient", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  test("refresh calls the refreshSession mutation over HTTP", async () => {
    const { requests } = stubConvexHttp(() => ({
      kind: "rotated",
      tokens: bundle(2),
    }));
    const auth = createAuthClient({
      url: URL,
      api: API,
      storage: new InMemoryStorage(),
    });
    await auth.init();
    await auth.setSession(bundle(1));

    const token = await auth.fetchAccessToken({ forceRefreshToken: true });

    expect(token).toBe("access-2");
    expect(requests()).toEqual([
      {
        url: `${URL}/api/mutation`,
        body: expect.objectContaining({
          path: "auth:refreshSession",
          args: [{ refreshToken: "refresh-1" }],
        }),
      },
    ]);
  });

  test("signOut calls the signOut mutation over HTTP", async () => {
    const { requests } = stubConvexHttp(() => null);
    const auth = createAuthClient({
      url: URL,
      api: API,
      storage: new InMemoryStorage(),
    });
    await auth.init();
    await auth.setSession(bundle(1));

    await auth.signOut();

    expect(requests()).toEqual([
      {
        url: `${URL}/api/mutation`,
        body: expect.objectContaining({
          path: "auth:signOut",
          args: [{ refreshToken: "refresh-1" }],
        }),
      },
    ]);
    expect(auth.getSnapshot().isAuthenticated).toBe(false);
  });

  test("storageNamespace defaults to the url", async () => {
    const storage = new InMemoryStorage();
    const auth = createAuthClient({ url: URL, api: API, storage });
    await auth.init();
    await auth.setSession(bundle(1));

    const namespaced = new NamespacedStorage(storage, URL);
    expect(storage.getItem(namespaced.key(JWT_STORAGE_KEY))).toBe("access-1");
    expect(storage.getItem(namespaced.key(REFRESH_TOKEN_STORAGE_KEY))).toBe(
      "refresh-1",
    );
  });

  test("a storageNamespace option replaces the url", async () => {
    const storage = new InMemoryStorage();
    const auth = createAuthClient({
      url: URL,
      api: API,
      storage,
      storageNamespace: "other",
    });
    await auth.init();
    await auth.setSession(bundle(1));

    expect(storage.getItem(`${JWT_STORAGE_KEY}_other`)).toBe("access-1");
  });

  test("the signInApi option sets the sign-in API", async () => {
    const mutation = vi.fn().mockResolvedValue("result");
    const auth = createAuthClient({
      url: URL,
      api: API,
      storage: new InMemoryStorage(),
      signInApi: { mutation, action: vi.fn() } as unknown as AuthSignInApi,
    });
    const signIn = makeFunctionReference<"mutation">("auth:signInProbe");

    await expect(auth.signIn.mutation(signIn, {})).resolves.toBe("result");
    expect(mutation).toHaveBeenCalledExactlyOnceWith(signIn, {});
  });

  test("without the signInApi option, sign-in rejects", async () => {
    const auth = createAuthClient({
      url: URL,
      api: API,
      storage: new InMemoryStorage(),
    });
    const signIn = makeFunctionReference<"mutation">("auth:signInProbe");

    await expect(auth.signIn.mutation(signIn, {})).rejects.toThrow(
      /No sign-in API is set/,
    );
  });

  test("the logger option receives the HTTP client's function logs", async () => {
    stubConvexHttp(() => null, ["[LOG] 'signing out'"]);
    const logger = {
      log: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
      logVerbose: vi.fn(),
    };
    const auth = createAuthClient({
      url: URL,
      api: API,
      storage: new InMemoryStorage(),
      logger,
    });
    await auth.init();
    await auth.setSession(bundle(1));

    await auth.signOut();

    expect(logger.log).toHaveBeenCalledWith(
      expect.stringContaining("auth:signOut"),
      expect.anything(),
      "'signing out'",
    );
  });
});
