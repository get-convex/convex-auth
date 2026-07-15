import { afterEach, describe, expect, test, vi } from "vitest";
import type { SlimTokenBundle, TokenBundle } from "../lib/types";
import { AuthClient, AuthApi } from "./sessionManager";
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
  authApi: Partial<AuthApi> = {},
  storage = new InMemoryStorage(),
) {
  const client = new AuthClient({
    authApi: {
      refreshSession: async () => null,
      signOut: async () => { },
      ...authApi,
    },
    storage,
    storageNamespace: NAMESPACE,
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
    const refreshSession = vi.fn(async (rt: string | null) => {
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
    const signOut = vi.fn(async (rt: string | null) => {
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
      removeEventListener: () => { },
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

function publicSession(n: number): SlimTokenBundle {
  return { accessToken: `access-${n}`, accessTokenExpiresAt: 0, userId: "user-1" };
}

// A "delegated" (SSR/cookie-based) session is not a separate mode — the client
// is configured identically, and the delegated shape emerges purely from the
// data: sign-in and refresh yield an access-only PublicSession, so no refresh
// token is ever stored, and the API is called with a `null` refresh token.
describe("AuthClient (delegated / access-only sessions)", () => {
  afterEach(() => {
    delete (globalThis as { window?: unknown }).window;
  });

  test("setSession adopts an access-only session, storing no refresh token", async () => {
    const { client, storage } = makeClient();
    await client.init();
    await client.setSession(publicSession(1));

    expect(client.getSnapshot()).toEqual({
      isLoading: false,
      isAuthenticated: true,
      token: "access-1",
    });
    expect(storage.getItem(`${JWT_STORAGE_KEY}_${SUFFIX}`)).toBe("access-1");
    // The refresh token lives in a server-only cookie — never in JS storage.
    expect(storage.getItem(`${REFRESH_TOKEN_STORAGE_KEY}_${SUFFIX}`)).toBeNull();
  });

  test("hydrates a delegated session from just the access token", async () => {
    const storage = new InMemoryStorage();
    storage.setItem(`${JWT_STORAGE_KEY}_${SUFFIX}`, "access-1");
    const { client } = makeClient({}, storage);
    await client.init();
    expect(client.getSnapshot()).toMatchObject({
      isAuthenticated: true,
      token: "access-1",
    });
  });

  test("forced fetch refreshes via the token-less (null) API call", async () => {
    const refreshSession = vi.fn(async () => publicSession(2));
    const { client, storage } = makeClient({ refreshSession });
    await client.init();
    await client.setSession(publicSession(1));

    const token = await client.fetchAccessToken({ forceRefreshToken: true });
    expect(token).toBe("access-2");
    expect(refreshSession).toHaveBeenCalledTimes(1);
    // No refresh token in JS, so the API is called with null (it reads the cookie).
    expect(refreshSession).toHaveBeenCalledWith(null);
    expect(storage.getItem(`${JWT_STORAGE_KEY}_${SUFFIX}`)).toBe("access-2");
    expect(storage.getItem(`${REFRESH_TOKEN_STORAGE_KEY}_${SUFFIX}`)).toBeNull();
  });

  test("a null delegated refresh clears the session", async () => {
    const { client, storage } = makeClient({
      refreshSession: async () => null,
    });
    await client.init();
    await client.setSession(publicSession(1));

    const token = await client.fetchAccessToken({ forceRefreshToken: true });
    expect(token).toBeNull();
    expect(client.getSnapshot()).toMatchObject({
      isAuthenticated: false,
      token: null,
    });
    expect(storage.getItem(`${JWT_STORAGE_KEY}_${SUFFIX}`)).toBeNull();
  });

  test("signOut calls the API with a null token and clears locally", async () => {
    const signOut = vi.fn(async () => { });
    const { client } = makeClient({ signOut });
    await client.init();
    await client.setSession(publicSession(1));

    await client.signOut();
    expect(signOut).toHaveBeenCalledTimes(1);
    expect(signOut).toHaveBeenCalledWith(null);
    expect(client.getSnapshot()).toMatchObject({
      isAuthenticated: false,
      token: null,
    });
  });
});
