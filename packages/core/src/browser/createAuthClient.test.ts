// @vitest-environment node
import { makeFunctionReference } from "convex/server";
import { afterEach, describe, expect, test, vi } from "vitest";
import type { ConvexAuthApi, TokenBundle } from "../lib/types.ts";
import type { AuthSignInApi } from "./signInApi.ts";
import {
  createAuthClient,
  type CreateAuthClientOptions,
} from "./createAuthClient.ts";
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

/** A stub Convex client for `URL`. `extra` replaces its fields. */
function stubConvex(extra: object = {}) {
  return {
    url: URL,
    mutation: vi.fn(),
    action: vi.fn(),
    ...extra,
  } as unknown as AuthSignInApi & { readonly url: string };
}

/** A stub Convex client with no `url`, like a `ConvexClient`. */
function stubConvexWithoutUrl(): AuthSignInApi {
  return { mutation: vi.fn(), action: vi.fn() } as unknown as AuthSignInApi;
}

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
      convex: stubConvex(),
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
      convex: stubConvex(),
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
    const auth = createAuthClient({
      convex: stubConvexWithoutUrl(),
      url: URL,
      api: API,
      storage,
    });
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
      convex: stubConvex(),
      api: API,
      storage,
      storageNamespace: "other",
    });
    await auth.init();
    await auth.setSession(bundle(1));

    expect(storage.getItem(`${JWT_STORAGE_KEY}_other`)).toBe("access-1");
  });

  test("url defaults to convex.url", async () => {
    const storage = new InMemoryStorage();
    const auth = createAuthClient({ convex: stubConvex(), api: API, storage });
    await auth.init();
    await auth.setSession(bundle(1));

    const namespaced = new NamespacedStorage(storage, URL);
    expect(storage.getItem(namespaced.key(JWT_STORAGE_KEY))).toBe("access-1");
    expect(storage.getItem(namespaced.key(REFRESH_TOKEN_STORAGE_KEY))).toBe(
      "refresh-1",
    );
  });

  test("an explicit url is used for a client with no url", async () => {
    const { requests } = stubConvexHttp(() => null);
    const storage = new InMemoryStorage();
    const auth = createAuthClient({
      convex: stubConvexWithoutUrl(),
      url: URL,
      api: API,
      storage,
    });
    await auth.init();
    await auth.setSession(bundle(1));
    const namespaced = new NamespacedStorage(storage, URL);
    expect(storage.getItem(namespaced.key(JWT_STORAGE_KEY))).toBe("access-1");

    await auth.signOut();

    expect(requests().map(({ url }) => url)).toEqual([`${URL}/api/mutation`]);
  });

  test("throws without a url option or a convex.url", () => {
    expect(() =>
      createAuthClient({
        convex: stubConvexWithoutUrl(),
        api: API,
        storage: new InMemoryStorage(),
      } as unknown as CreateAuthClientOptions),
    ).toThrow(
      "[convex-auth] createAuthClient needs a url option, because this " +
        "Convex client has no url.",
    );
  });

  test("a url that differs from convex.url throws", () => {
    expect(() =>
      createAuthClient({
        convex: stubConvex(),
        url: "https://other-animal-456.convex.cloud",
        api: API,
        storage: new InMemoryStorage(),
      }),
    ).toThrow(
      `[convex-auth] The Convex client is for ${URL}, but this auth client ` +
        "is for https://other-animal-456.convex.cloud. Build a new auth " +
        "client for a different deployment.",
    );
  });

  test("sign-in runs on convex", async () => {
    const mutation = vi.fn().mockResolvedValue("mutation-result");
    const action = vi.fn().mockResolvedValue("action-result");
    const auth = createAuthClient({
      convex: stubConvex({ mutation, action }),
      api: API,
      storage: new InMemoryStorage(),
    });
    const signIn = makeFunctionReference<"mutation">("auth:signInProbe");
    const signInAction = makeFunctionReference<"action">("auth:actionProbe");

    await expect(auth.signIn.mutation(signIn, {})).resolves.toBe(
      "mutation-result",
    );
    await expect(auth.signIn.action(signInAction, {})).resolves.toBe(
      "action-result",
    );
    expect(mutation).toHaveBeenCalledExactlyOnceWith(signIn, {});
    expect(action).toHaveBeenCalledExactlyOnceWith(signInAction, {});
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
      convex: stubConvex(),
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

  test("without a logger option, the HTTP client uses the Convex client's logger", async () => {
    stubConvexHttp(() => null, ["[LOG] 'signing out'"]);
    const logger = {
      log: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
      logVerbose: vi.fn(),
    };
    const auth = createAuthClient({
      convex: stubConvex({ logger }),
      api: API,
      storage: new InMemoryStorage(),
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

  test("the url option is required for a Convex client with no url", () => {
    expect(() =>
      // @ts-expect-error A Convex client with no `url` needs the `url` option.
      createAuthClient({ convex: stubConvexWithoutUrl(), api: API }),
    ).toThrow(/needs a url option/);
  });
});
