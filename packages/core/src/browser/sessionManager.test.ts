import { makeFunctionReference } from "convex/server";
import { afterEach, describe, expect, test, vi } from "vitest";
import type {
  RefreshResult,
  SlimTokenBundle,
  TokenBundle,
} from "../lib/types.ts";
import {
  AuthClient,
  INITIAL_AUTH_STATE,
  SpaAuthApi,
  SsrAuthApi,
} from "./sessionManager.ts";
import type { AuthSignInApi } from "./signInApi.ts";
import {
  InMemoryStorage,
  JWT_STORAGE_KEY,
  NamespacedStorage,
  REFRESH_TOKEN_STORAGE_KEY,
  type TokenStorage,
} from "./storage.ts";

const NAMESPACE = "https://happy-animal-123.convex.cloud";
// Matches NamespacedStorage's `replace(/[^a-zA-Z0-9]/g, "")`.
const SUFFIX = "httpshappyanimal123convexcloud";

// Tests below swap in a stub `window` to simulate other runtimes. The
// edge-runtime environment these tests run in supplies its own (`window ===
// globalThis`, with working DOM event APIs), so we put that back afterwards.
const ORIGINAL_WINDOW = Object.getOwnPropertyDescriptor(globalThis, "window");

function restoreWindow(): void {
  if (ORIGINAL_WINDOW === undefined) {
    delete (globalThis as { window?: unknown }).window;
  } else {
    Object.defineProperty(globalThis, "window", ORIGINAL_WINDOW);
  }
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

/** A `rotated` refresh outcome carrying `bundle(n)`. */
function rotated(n: number): RefreshResult {
  return { kind: "rotated", tokens: bundle(n) };
}

/**
 * A `reused` outcome: a concurrent caller had already rotated the token we
 * presented, so only an access token comes back.
 */
function reused(n: number): RefreshResult {
  const { accessToken, accessTokenExpiresAt, refreshTokenExpiresAt, userId } =
    bundle(n);
  return {
    kind: "reused",
    accessToken,
    accessTokenExpiresAt,
    refreshTokenExpiresAt,
    userId,
  };
}

// `storage` is typed as the interface rather than the concrete default so the
// async-store tests below can pass their own implementation.
function makeClient(
  authApi: Partial<SpaAuthApi> = {},
  storage: TokenStorage = new InMemoryStorage(),
) {
  const client = new AuthClient({
    mode: "spa",
    authApi: {
      refreshSession: async () => ({ kind: "noSession" }),
      signOut: async () => {},
      ...authApi,
    },
    storage,
    storageNamespace: NAMESPACE,
  });
  return { client, storage };
}

function makeSsrClient(
  authApi: Partial<SsrAuthApi> = {},
  storage = new InMemoryStorage(),
) {
  const client = new AuthClient({
    mode: "ssr",
    authApi: {
      refreshSession: async () => null,
      signOut: async () => {},
      ...authApi,
    },
    storage,
    storageNamespace: NAMESPACE,
  });
  return { client, storage };
}

describe("AuthClient", () => {
  afterEach(restoreWindow);

  test("starts unauthenticated with an empty store", async () => {
    const { client } = makeClient();
    expect(client.getSnapshot()).toMatchObject({ isLoading: true });
    await client.init();
    expect(client.getSnapshot()).toEqual({
      isLoading: false,
      isAuthenticated: false,
      token: null,
    });
  });

  test("setSession authenticates and persists under namespaced keys", async () => {
    const { client, storage } = makeClient();
    await client.init();
    await client.setSession(bundle(1));

    expect(client.getSnapshot()).toEqual({
      isLoading: false,
      isAuthenticated: true,
      token: "access-1",
    });
    expect(client.getAccessToken()).toBe("access-1");
    expect(storage.getItem(`${JWT_STORAGE_KEY}_${SUFFIX}`)).toBe("access-1");
    expect(storage.getItem(`${REFRESH_TOKEN_STORAGE_KEY}_${SUFFIX}`)).toBe(
      "refresh-1",
    );
  });

  test("hydrates a persisted session on init", async () => {
    const storage = new InMemoryStorage();
    storage.setItem(`${JWT_STORAGE_KEY}_${SUFFIX}`, "access-1");
    storage.setItem(`${REFRESH_TOKEN_STORAGE_KEY}_${SUFFIX}`, "refresh-1");
    const { client } = makeClient({}, storage);
    await client.init();
    expect(client.getSnapshot()).toMatchObject({
      isAuthenticated: true,
      token: "access-1",
    });
  });

  test("fetchAccessToken returns the cached token without forcing", async () => {
    const refreshSession = vi.fn(async () => rotated(2));
    const { client } = makeClient({ refreshSession });
    await client.init();
    await client.setSession(bundle(1));

    const token = await client.fetchAccessToken({ forceRefreshToken: false });
    expect(token).toBe("access-1");
    expect(refreshSession).not.toHaveBeenCalled();
  });

  test("forced fetch rotates the session via refreshSession", async () => {
    const refreshSession = vi.fn(async (rt: string) => {
      expect(rt).toBe("refresh-1");
      return rotated(2);
    });
    const { client, storage } = makeClient({ refreshSession });
    await client.init();
    await client.setSession(bundle(1));

    const token = await client.fetchAccessToken({ forceRefreshToken: true });
    expect(token).toBe("access-2");
    expect(refreshSession).toHaveBeenCalledTimes(1);
    expect(storage.getItem(`${REFRESH_TOKEN_STORAGE_KEY}_${SUFFIX}`)).toBe(
      "refresh-2",
    );
  });

  test("a reused refresh takes the access token and keeps the stored refresh token", async () => {
    const refreshSession = vi.fn(async () => reused(2));
    const { client, storage } = makeClient({ refreshSession });
    await client.init();
    await client.setSession(bundle(1));

    const token = await client.fetchAccessToken({ forceRefreshToken: true });

    // A concurrent caller already rotated `refresh-1` and persisted the
    // replacement. Clearing ours here would leave this client with no way to
    // rotate, and it would expire silently at the next access-token expiry.
    expect(token).toBe("access-2");
    expect(storage.getItem(`${JWT_STORAGE_KEY}_${SUFFIX}`)).toBe("access-2");
    expect(storage.getItem(`${REFRESH_TOKEN_STORAGE_KEY}_${SUFFIX}`)).toBe(
      "refresh-1",
    );
    expect(client.getSnapshot()).toMatchObject({
      isAuthenticated: true,
      token: "access-2",
    });
  });

  test("a reused refresh is not a sign-out", async () => {
    // The next forced fetch must still reach the server with the stored token,
    // rather than short-circuiting as if there were no session.
    const refreshSession = vi
      .fn<(rt: string) => Promise<RefreshResult>>()
      .mockResolvedValueOnce(reused(2))
      .mockResolvedValueOnce(rotated(3));
    const { client, storage } = makeClient({ refreshSession });
    await client.init();
    await client.setSession(bundle(1));

    await client.fetchAccessToken({ forceRefreshToken: true });
    expect(await client.fetchAccessToken({ forceRefreshToken: true })).toBe(
      "access-3",
    );
    expect(refreshSession).toHaveBeenNthCalledWith(2, "refresh-1");
    expect(storage.getItem(`${REFRESH_TOKEN_STORAGE_KEY}_${SUFFIX}`)).toBe(
      "refresh-3",
    );
  });

  test("a noSession refresh result clears the session", async () => {
    const { client, storage } = makeClient({
      refreshSession: async () => ({ kind: "noSession" }),
    });
    await client.init();
    await client.setSession(bundle(1));

    const token = await client.fetchAccessToken({ forceRefreshToken: true });
    expect(token).toBeNull();
    expect(client.getSnapshot()).toMatchObject({
      isAuthenticated: false,
      token: null,
    });
    expect(storage.getItem(`${JWT_STORAGE_KEY}_${SUFFIX}`)).toBeNull();
  });

  test("concurrent forced fetches collapse to a single refresh", async () => {
    const { promise, resolve } = Promise.withResolvers<void>();
    const refreshSession = vi.fn(async () => {
      await promise;
      return rotated(2);
    });
    const { client } = makeClient({ refreshSession });
    await client.init();
    await client.setSession(bundle(1));

    const pending = [
      client.fetchAccessToken({ forceRefreshToken: true }),
      client.fetchAccessToken({ forceRefreshToken: true }),
      client.fetchAccessToken({ forceRefreshToken: true }),
    ];
    resolve();
    const results = await Promise.all(pending);

    expect(refreshSession).toHaveBeenCalledTimes(1);
    expect(results).toEqual(["access-2", "access-2", "access-2"]);
  });

  test("signOut revokes on the server and clears locally", async () => {
    const signOut = vi.fn(async (rt: string) => {
      expect(rt).toBe("refresh-1");
    });
    const { client } = makeClient({ signOut });
    await client.init();
    await client.setSession(bundle(1));

    await client.signOut();
    expect(signOut).toHaveBeenCalledTimes(1);
    expect(client.getSnapshot()).toMatchObject({
      isAuthenticated: false,
      token: null,
    });
  });

  test("syncs sign-out from another tab via storage events", async () => {
    const listeners: Array<(event: StorageEvent) => void> = [];
    const storage = new InMemoryStorage();
    (globalThis as { window?: unknown }).window = {
      addEventListener: (_type: string, l: (event: StorageEvent) => void) =>
        listeners.push(l),
      removeEventListener: () => {},
    };

    const { client } = makeClient({}, storage);
    await client.init();
    await client.setSession(bundle(1));
    expect(client.getSnapshot().isAuthenticated).toBe(true);

    // Another tab cleared the JWT key.
    listeners.forEach((l) =>
      l({
        storageArea: storage,
        key: `${JWT_STORAGE_KEY}_${SUFFIX}`,
        newValue: null,
      } as unknown as StorageEvent),
    );

    expect(client.getSnapshot()).toMatchObject({
      isAuthenticated: false,
      token: null,
    });
  });

  test("works where `window` exists without DOM event APIs (React Native)", async () => {
    // React Native's global object *is* `window`, but it has no
    // addEventListener/removeEventListener. Cross-tab sync is skipped rather
    // than throwing when the provider mounts.
    (globalThis as { window?: unknown }).window = { navigator: {} };

    const { client } = makeClient();
    await expect(client.init()).resolves.toBeUndefined();
    await client.setSession(bundle(1));
    expect(client.getSnapshot().isAuthenticated).toBe(true);
    expect(() => client.dispose()).not.toThrow();
  });

  test("works where there is no `window` at all (server runtime)", async () => {
    delete (globalThis as { window?: unknown }).window;

    const { client } = makeClient();
    await expect(client.init()).resolves.toBeUndefined();
    await client.setSession(bundle(1));
    expect(client.getSnapshot().isAuthenticated).toBe(true);
    expect(() => client.dispose()).not.toThrow();
  });

  test("withSignInPending turns loading on while its call is pending", async () => {
    const { client } = makeClient();
    await client.init();
    expect(client.getSnapshot().isLoading).toBe(false);

    const { promise, resolve } = Promise.withResolvers<string>();
    const pending = client.withSignInPending(() => promise);
    expect(client.getSnapshot().isLoading).toBe(true);

    resolve("done");
    await expect(pending).resolves.toBe("done");
    expect(client.getSnapshot().isLoading).toBe(false);
  });

  test("withSignInPending entered before init reports loading past the session load", async () => {
    // An OAuth callback page enters it from a mount effect, which runs before
    // the provider's init effect. The redemption finishes after the session
    // loads, and the client must not report signed out in between.
    const { client } = makeClient();
    const signIn = Promise.withResolvers<void>();
    const pending = client.withSignInPending(async () => {
      await signIn.promise;
      await client.setSession(bundle(1));
    });

    await client.init();
    expect(client.getSnapshot()).toEqual({
      isLoading: true,
      isAuthenticated: false,
      token: null,
    });

    signIn.resolve();
    await pending;
    expect(client.getSnapshot()).toEqual({
      isLoading: false,
      isAuthenticated: true,
      token: "access-1",
    });
  });

  test("withSignInPending clears loading when the completion throws", async () => {
    const { client } = makeClient();
    await client.init();

    await expect(
      client.withSignInPending(async () => {
        throw new Error("redemption failed");
      }),
    ).rejects.toThrow("redemption failed");
    expect(client.getSnapshot().isLoading).toBe(false);
  });

  test("overlapping completions keep loading until the last settles", async () => {
    const { client } = makeClient();
    await client.init();

    const first = Promise.withResolvers<void>();
    const second = Promise.withResolvers<void>();
    const pending = [
      client.withSignInPending(() => first.promise),
      client.withSignInPending(() => second.promise),
    ];

    first.resolve();
    await pending[0];
    expect(client.getSnapshot().isLoading).toBe(true);

    second.resolve();
    await pending[1];
    expect(client.getSnapshot().isLoading).toBe(false);
  });

  test("re-attaches the storage listener when init runs after dispose", async () => {
    const listeners = new Set<(event: StorageEvent) => void>();
    const storage = new InMemoryStorage();
    (globalThis as { window?: unknown }).window = {
      addEventListener: (_type: string, l: (event: StorageEvent) => void) =>
        listeners.add(l),
      removeEventListener: (_type: string, l: (event: StorageEvent) => void) =>
        listeners.delete(l),
    };

    const { client } = makeClient({}, storage);
    // init/dispose is a symmetric, repeatable lifecycle: an init() after a
    // dispose() must restore cross-tab sync. (A consumer that re-mounts the same
    // client — e.g. React StrictMode — drives exactly this sequence; that path
    // is covered end-to-end in the React bindings' tests.)
    await client.init();
    client.dispose();
    await client.init();
    await client.setSession(bundle(1));
    expect(client.getSnapshot().isAuthenticated).toBe(true);
    expect(listeners.size).toBe(1);

    // Another tab cleared the JWT key.
    listeners.forEach((l) =>
      l({
        storageArea: storage,
        key: `${JWT_STORAGE_KEY}_${SUFFIX}`,
        newValue: null,
      } as unknown as StorageEvent),
    );

    expect(client.getSnapshot()).toMatchObject({
      isAuthenticated: false,
      token: null,
    });
  });
});

/** A stub sign-in API. */
const SIGN_IN_API = {
  mutation: vi.fn(),
  action: vi.fn(),
} as unknown as AuthSignInApi;

/** A reference to pass the stub. Its path is never resolved. */
const SIGN_IN_REF = makeFunctionReference<"mutation">("auth:probeSignIn");

describe("AuthClient sign-in API", () => {
  test("signIn.mutation and signIn.action forward to the set API", async () => {
    const { client } = makeClient();
    const mutation = vi.fn().mockResolvedValue("mutation-result");
    const action = vi.fn().mockResolvedValue("action-result");
    client.setSignInApi({ mutation, action } as unknown as AuthSignInApi);
    const signInAction = makeFunctionReference<"action">("auth:probeAction");

    await expect(client.signIn.mutation(SIGN_IN_REF, { a: 1 })).resolves.toBe(
      "mutation-result",
    );
    await expect(client.signIn.action(signInAction, { b: 2 })).resolves.toBe(
      "action-result",
    );
    expect(mutation).toHaveBeenCalledExactlyOnceWith(SIGN_IN_REF, { a: 1 });
    expect(action).toHaveBeenCalledExactlyOnceWith(signInAction, { b: 2 });
  });

  test("signIn rejects with a clear error when no API is set", async () => {
    const { client } = makeClient();
    const signInAction = makeFunctionReference<"action">("auth:probeAction");
    await expect(client.signIn.mutation(SIGN_IN_REF, {})).rejects.toThrow(
      /No sign-in API is set on this AuthClient/,
    );
    await expect(client.signIn.action(signInAction, {})).rejects.toThrow(
      /setSignInApi\(convexClient\)/,
    );
  });

  test("setSignInApi replaces the previous API", async () => {
    const { client } = makeClient();
    const first = vi.fn().mockResolvedValue("first");
    const second = vi.fn().mockResolvedValue("second");
    client.setSignInApi({ mutation: first } as unknown as AuthSignInApi);
    client.setSignInApi({ mutation: second } as unknown as AuthSignInApi);

    await expect(client.signIn.mutation(SIGN_IN_REF, {})).resolves.toBe(
      "second",
    );
    expect(first).not.toHaveBeenCalled();
  });

  test("signIn keeps its identity when the API changes", () => {
    const { client } = makeClient();
    const before = client.signIn;
    client.setSignInApi(SIGN_IN_API);
    expect(client.signIn).toBe(before);
  });
});

describe("AuthClient sign-in storage", () => {
  test("throws when the id is not alphanumeric", () => {
    const { client } = makeClient();
    expect(() => client.signInStorage("pass-key")).toThrow(
      /Sign-in id "pass-key" is invalid/,
    );
    expect(() => client.signInStorage("")).toThrow(/is invalid/);
  });

  test("keys are scoped by id and by the client's namespace", async () => {
    const storage = new InMemoryStorage();
    const { client } = makeClient({}, storage);
    const oauthStorage = client.signInStorage("oauth");
    const emailStorage = client.signInStorage("email");

    await oauthStorage.set("flow", "v1");
    await emailStorage.set("flow", "v2");

    const namespaced = new NamespacedStorage(storage, NAMESPACE);
    expect(
      storage.getItem(namespaced.key("__convexAuthProvider_oauth_flow")),
    ).toBe("v1");
    expect(
      storage.getItem(namespaced.key("__convexAuthProvider_email_flow")),
    ).toBe("v2");
    expect(await oauthStorage.get("flow")).toBe("v1");

    await oauthStorage.remove("flow");
    expect(await oauthStorage.get("flow")).toBeNull();
    expect(await emailStorage.get("flow")).toBe("v2");
  });

  test("keys never collide with the session keys", async () => {
    const storage = new InMemoryStorage();
    const { client } = makeClient({}, storage);
    await client.init();
    await client.setSession(bundle(1));
    await client.signInStorage("oauth").set(JWT_STORAGE_KEY, "other");

    expect(storage.getItem(`${JWT_STORAGE_KEY}_${SUFFIX}`)).toBe("access-1");
  });
});

/**
 * Returns a {@link SlimTokenBundle} which is the typical auth response from
 * an SSR integration.
 */
function ssrAuthResult(n: number): SlimTokenBundle {
  return {
    accessToken: `access-${n}`,
    accessTokenExpiresAt: 0,
    userId: "user-1",
  };
}

describe("AuthClient (SSR)", () => {
  afterEach(restoreWindow);

  test("setSession adopts an access-only session, storing no refresh token", async () => {
    const { client, storage } = makeSsrClient();
    await client.init();
    await client.setSession(ssrAuthResult(1));

    expect(client.getSnapshot()).toEqual({
      isLoading: false,
      isAuthenticated: true,
      token: "access-1",
    });
    expect(storage.getItem(`${JWT_STORAGE_KEY}_${SUFFIX}`)).toBe("access-1");
    // The refresh token lives in a server-only cookie — never in JS storage.
    expect(
      storage.getItem(`${REFRESH_TOKEN_STORAGE_KEY}_${SUFFIX}`),
    ).toBeNull();
  });

  test("hydrates a session from just the access token", async () => {
    const storage = new InMemoryStorage();
    storage.setItem(`${JWT_STORAGE_KEY}_${SUFFIX}`, "access-1");
    const { client } = makeSsrClient({}, storage);
    await client.init();
    expect(client.getSnapshot()).toMatchObject({
      isAuthenticated: true,
      token: "access-1",
    });
  });

  test("forced fetch refreshes via the token-less API call", async () => {
    const refreshSession = vi.fn(async () => ssrAuthResult(2));
    const { client, storage } = makeSsrClient({ refreshSession });
    await client.init();
    await client.setSession(ssrAuthResult(1));

    const token = await client.fetchAccessToken({ forceRefreshToken: true });
    expect(token).toBe("access-2");
    expect(refreshSession).toHaveBeenCalledTimes(1);
    // No refresh token in JS, so the API is called with no arguments (it reads
    // the cookie server-side).
    expect(refreshSession).toHaveBeenCalledWith();
    expect(storage.getItem(`${JWT_STORAGE_KEY}_${SUFFIX}`)).toBe("access-2");
    expect(
      storage.getItem(`${REFRESH_TOKEN_STORAGE_KEY}_${SUFFIX}`),
    ).toBeNull();
  });

  test("a null refresh clears the session", async () => {
    const { client, storage } = makeSsrClient({
      refreshSession: async () => null,
    });
    await client.init();
    await client.setSession(ssrAuthResult(1));

    const token = await client.fetchAccessToken({ forceRefreshToken: true });
    expect(token).toBeNull();
    expect(client.getSnapshot()).toMatchObject({
      isAuthenticated: false,
      token: null,
    });
    expect(storage.getItem(`${JWT_STORAGE_KEY}_${SUFFIX}`)).toBeNull();
  });

  test("signOut calls the API with no arguments and clears locally", async () => {
    const signOut = vi.fn(async () => {});
    const { client } = makeSsrClient({ signOut });
    await client.init();
    await client.setSession(ssrAuthResult(1));

    await client.signOut();
    expect(signOut).toHaveBeenCalledTimes(1);
    expect(signOut).toHaveBeenCalledWith();
    expect(client.getSnapshot()).toMatchObject({
      isAuthenticated: false,
      token: null,
    });
  });

  test("initialAccessToken wins over a persisted token and is stored", async () => {
    // The SSR host may have refreshed on the client's behalf, so its token is
    // fresher than anything already in storage. It wins and is stored.
    const storage = new InMemoryStorage();
    storage.setItem(`${JWT_STORAGE_KEY}_${SUFFIX}`, "stale-access");
    const { client } = makeSsrClient({}, storage);
    await client.init({ initialAccessToken: "access-ssr" });

    expect(client.getSnapshot()).toMatchObject({
      isAuthenticated: true,
      token: "access-ssr",
    });
    expect(storage.getItem(`${JWT_STORAGE_KEY}_${SUFFIX}`)).toBe("access-ssr");
  });

  test("init uses initialAccessToken only on its first call", async () => {
    const storage = new InMemoryStorage();
    const { client } = makeSsrClient({}, storage);
    await client.init({ initialAccessToken: "access-ssr" });
    client.dispose();
    await client.init({ initialAccessToken: "access-later" });

    expect(client.getSnapshot().token).toBe("access-ssr");
    expect(storage.getItem(`${JWT_STORAGE_KEY}_${SUFFIX}`)).toBe("access-ssr");
  });

  test("a null initialAccessToken leaves the persisted token alone", async () => {
    const storage = new InMemoryStorage();
    storage.setItem(`${JWT_STORAGE_KEY}_${SUFFIX}`, "access-1");
    const { client } = makeSsrClient({}, storage);
    await client.init({ initialAccessToken: null });

    expect(client.getSnapshot().token).toBe("access-1");
  });

  test("clears refresh token if present", async () => {
    const refreshSession = vi.fn(async () => ssrAuthResult(2));
    const storage = new InMemoryStorage();
    storage.setItem(`${REFRESH_TOKEN_STORAGE_KEY}_${SUFFIX}`, "refresh-1");
    const { client } = makeSsrClient({ refreshSession }, storage);
    await client.init();
    await client.fetchAccessToken({ forceRefreshToken: true });
    expect(storage.getItem(`${REFRESH_TOKEN_STORAGE_KEY}_${SUFFIX}`)).toBe(
      null,
    );
  });
});

/**
 * A {@link TokenStorage} whose every method returns a promise, like in React
 * Native.
 */
class AsyncTokenStorage implements TokenStorage {
  readonly entries = new Map<string, string>();

  async getItem(key: string): Promise<string | null> {
    await Promise.resolve();
    return this.entries.get(key) ?? null;
  }
  async setItem(key: string, value: string): Promise<void> {
    await Promise.resolve();
    this.entries.set(key, value);
  }
  async removeItem(key: string): Promise<void> {
    await Promise.resolve();
    this.entries.delete(key);
  }
}

describe("AuthClient (async storage)", () => {
  afterEach(restoreWindow);

  test("hydrates a persisted session on init", async () => {
    // The case that matters on React Native: a session survives an app
    // restart, rather than the user landing on the sign-in screen every launch.
    const storage = new AsyncTokenStorage();
    storage.entries.set(`${JWT_STORAGE_KEY}_${SUFFIX}`, "access-1");
    storage.entries.set(`${REFRESH_TOKEN_STORAGE_KEY}_${SUFFIX}`, "refresh-1");

    const { client } = makeClient({}, storage);
    await client.init();

    expect(client.getSnapshot()).toEqual({
      isLoading: false,
      isAuthenticated: true,
      token: "access-1",
    });
  });

  test("reports loading until the store resolves", async () => {
    const storage = new AsyncTokenStorage();
    storage.entries.set(`${JWT_STORAGE_KEY}_${SUFFIX}`, "access-1");

    const { client } = makeClient({}, storage);
    const initialized = client.init();
    // A store that answers asynchronously must not be reported as "signed out"
    // in the meantime — that flash would bounce the user to a sign-in screen.
    expect(client.getSnapshot()).toEqual(INITIAL_AUTH_STATE);

    await initialized;
    expect(client.getSnapshot()).toMatchObject({ isAuthenticated: true });
  });

  test("persists, rotates and clears through the async store", async () => {
    const refreshSession = vi.fn(async (rt: string) => {
      // The rotated token must be read back out of the async store, not just
      // held in memory.
      expect(rt).toBe("refresh-1");
      return rotated(2);
    });
    const storage = new AsyncTokenStorage();
    const { client } = makeClient({ refreshSession }, storage);
    await client.init();

    await client.setSession(bundle(1));
    expect(storage.entries.get(`${JWT_STORAGE_KEY}_${SUFFIX}`)).toBe(
      "access-1",
    );
    expect(storage.entries.get(`${REFRESH_TOKEN_STORAGE_KEY}_${SUFFIX}`)).toBe(
      "refresh-1",
    );

    expect(await client.fetchAccessToken({ forceRefreshToken: true })).toBe(
      "access-2",
    );
    expect(storage.entries.get(`${REFRESH_TOKEN_STORAGE_KEY}_${SUFFIX}`)).toBe(
      "refresh-2",
    );

    await client.signOut();
    expect(storage.entries.size).toBe(0);
  });
});

describe("AuthClient setSession during init", () => {
  afterEach(restoreWindow);

  test("a session set while init reads storage is not lost", async () => {
    // The reads resolve only when the test calls `resolveReads`, so the
    // session is set after init starts its read and before the read returns.
    let resolveReads!: (value: null) => void;
    const reads = new Promise<null>((resolve) => {
      resolveReads = resolve;
    });
    const entries = new Map<string, string>();
    const storage: TokenStorage = {
      getItem: () => reads,
      setItem: (key, value) => {
        entries.set(key, value);
      },
      removeItem: (key) => {
        entries.delete(key);
      },
    };

    const { client } = makeClient({}, storage);
    const initialized = client.init();
    const set = client.setSession(bundle(1));
    resolveReads(null);
    await Promise.all([initialized, set]);

    expect(client.getSnapshot()).toEqual({
      isLoading: false,
      isAuthenticated: true,
      token: "access-1",
    });
    expect(entries.get(`${JWT_STORAGE_KEY}_${SUFFIX}`)).toBe("access-1");
  });

  test("setSession before any init call stores the session", async () => {
    const { client } = makeClient();
    await client.setSession(bundle(1));

    expect(client.getSnapshot()).toEqual({
      isLoading: false,
      isAuthenticated: true,
      token: "access-1",
    });
  });
});
