import { afterEach, describe, expect, test, vi } from "vitest";
import type { SlimTokenBundle, TokenBundle } from "../lib/types";
import { AuthClient, SpaAuthApi, SsrAuthApi } from "./sessionManager";
import {
  InMemoryStorage,
  JWT_STORAGE_KEY,
  REFRESH_TOKEN_STORAGE_KEY,
} from "./storage";

const NAMESPACE = "https://happy-animal-123.convex.cloud";
// Matches NamespacedStorage's `replace(/[^a-zA-Z0-9]/g, "")`.
const SUFFIX = "httpshappyanimal123convexcloud";

function bundle(n: number): TokenBundle {
  return {
    accessToken: `access-${n}`,
    accessTokenExpiresAt: 0,
    refreshToken: `refresh-${n}`,
    refreshTokenExpiresAt: 0,
    userId: "user-1",
  };
}

function makeClient(
  authApi: Partial<SpaAuthApi> = {},
  storage = new InMemoryStorage(),
) {
  const client = new AuthClient({
    mode: "spa",
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

function makeSsrClient(
  authApi: Partial<SsrAuthApi> = {},
  storage = new InMemoryStorage(),
  extra: { initialAccessToken?: string | null } = {},
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
    ...extra,
  });
  return { client, storage };
}

describe("AuthClient", () => {
  afterEach(() => {
    delete (globalThis as { window?: unknown }).window;
  });

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
    const refreshSession = vi.fn(async () => bundle(2));
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
      return bundle(2);
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

  test("a null refresh clears the session", async () => {
    const { client, storage } = makeClient({
      refreshSession: async () => null,
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
      return bundle(2);
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
  afterEach(() => {
    delete (globalThis as { window?: unknown }).window;
  });

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
    // fresher than anything already in storage — it should win and persist.
    const storage = new InMemoryStorage();
    storage.setItem(`${JWT_STORAGE_KEY}_${SUFFIX}`, "stale-access");
    const { client } = makeSsrClient({}, storage, {
      initialAccessToken: "access-ssr",
    });
    await client.init();

    expect(client.getSnapshot()).toMatchObject({
      isAuthenticated: true,
      token: "access-ssr",
    });
    expect(storage.getItem(`${JWT_STORAGE_KEY}_${SUFFIX}`)).toBe("access-ssr");
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
