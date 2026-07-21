/**
 * Regression tests for the framework-agnostic client auth state machine
 * (`packages/auth/src/client/index.ts`).
 *
 * These drive the state machine through a fake `ConvexReactClient`, a fake
 * action-only `httpClient`, an injectable proxy runtime, and a synchronous
 * in-memory storage — the same construction shape the browser/expo entrypoints
 * use. They cover the correctness fixes for:
 *
 *   1. signOut vs. in-flight forced-refresh race (a refresh that resolves after
 *      signOut must not re-authenticate).
 *   2. handshake-timeout trap (a timed-out sign-in resolves to signed-out, not a
 *      stuck loading state) and confirmed->false deauth (a server-side revoke
 *      eventually signs out, while a transient mid-rotation false is tolerated).
 *   3. refresh-failure handling (transient network errors keep the session;
 *      auth rejections — non-proxy INVALID_REFRESH_TOKEN and proxy 401 — sign
 *      out and break the re-force-refresh loop).
 *   4. SSR token seed surfaced synchronously via `getSnapshot()` (the value the
 *      React `getServerSnapshot` now returns instead of a hardcoded LOADING).
 *   5. cross-tab storage sync (same-subject rotation adopted without flicker;
 *      different-subject token ignored).
 *   8. destroy() rejects in-flight handshakes and clears their timers.
 */
import { client } from "@robelest/convex-auth/client";
import { ConvexError } from "convex/values";
import { afterEach, expect, test, vi } from "vite-plus/test";

const CONVEX_URL = "https://example.convex.cloud";

function createConvexMock(): any {
  const authRegistrations: Array<{
    fetchToken: (args: { forceRefreshToken: boolean }) => Promise<string | null | undefined>;
    onChange?: (isAuthenticated: boolean) => void;
  }> = [];

  return {
    action: vi.fn(async (..._args: any[]) => null as any),
    setAuth: vi.fn((fetchToken, onChange) => {
      authRegistrations.push({ fetchToken, onChange });
    }),
    clearAuth: vi.fn(),
    authRegistrations,
    latestFetchToken() {
      return authRegistrations[authRegistrations.length - 1]?.fetchToken;
    },
    triggerAuthChange(isAuthenticated: boolean) {
      authRegistrations[authRegistrations.length - 1]?.onChange?.(isAuthenticated);
    },
  };
}

/**
 * Synchronous, seedable storage. `getItem` returns synchronously so the client's
 * synchronous `readInitialToken` boot path can hydrate a stored token; writes and
 * removes mutate the backing map. Namespaced keys collapse to their logical name.
 */
function createSyncStorage(seed: { jwt?: string; refresh?: string } = {}) {
  const map = new Map<string, string>();
  if (seed.jwt !== undefined) map.set("__convexAuthJWT", seed.jwt);
  if (seed.refresh !== undefined) map.set("__convexAuthRefreshToken", seed.refresh);
  const logical = (fullKey: string): string => {
    if (fullKey.startsWith("__convexAuthJWT")) return "__convexAuthJWT";
    if (fullKey.startsWith("__convexAuthRefreshToken")) return "__convexAuthRefreshToken";
    return fullKey;
  };
  return {
    map,
    getItem: (key: string): string | null => map.get(logical(key)) ?? null,
    setItem: (key: string, value: string): void => {
      map.set(logical(key), value);
    },
    removeItem: (key: string): void => {
      map.delete(logical(key));
    },
  };
}

/** Build an unsigned JWT string carrying `sub` (plus optional extra claims). */
function makeJwt(sub: string, extra: Record<string, unknown> = {}): string {
  const b64url = (obj: unknown) =>
    btoa(JSON.stringify(obj)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
  return `${b64url({ alg: "none", typ: "JWT" })}.${b64url({ sub, ...extra })}.sig`;
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

const flushMicrotasks = () => new Promise((resolve) => setTimeout(resolve, 0));

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

// ---------------------------------------------------------------------------
// 1. signOut vs. in-flight forced-refresh race
// ---------------------------------------------------------------------------

test("signOut wins a race against an in-flight forced refresh (non-proxy)", async () => {
  const convex = createConvexMock();
  const storage = createSyncStorage({ jwt: "token-A", refresh: "refresh-A" });

  let releaseRefresh!: () => void;
  const refreshGate = new Promise<void>((resolve) => {
    releaseRefresh = resolve;
  });
  const httpClient = {
    action: vi.fn(async () => {
      await refreshGate;
      return { kind: "signedIn", session: { token: "token-B", refreshToken: "refresh-B" } };
    }),
  };

  const auth = client({
    convex,
    api: { signIn: {} as never, signOut: {} as never },
    url: CONVEX_URL,
    storage,
    httpClient,
  });

  expect(auth.getSnapshot()).toEqual({ status: "signedIn", token: "token-A" });

  const fetchAccessToken = convex.latestFetchToken()!;
  // Start a forced refresh and let it park on the (gated) exchange.
  const refreshPromise = fetchAccessToken({ forceRefreshToken: true });
  await flushMicrotasks();

  // signOut clears the token + storage and bumps the auth epoch while the
  // refresh is still in flight.
  await auth.signOut();
  expect(auth.getSnapshot()).toEqual({ status: "signedOut", token: null });

  // The refresh now resolves with a fresh session — it must be discarded.
  releaseRefresh();
  await expect(refreshPromise).resolves.toBeNull();

  expect(auth.getSnapshot()).toEqual({ status: "signedOut", token: null });
  expect(storage.map.get("__convexAuthJWT")).toBeUndefined();
  expect(storage.map.get("__convexAuthRefreshToken")).toBeUndefined();

  auth.destroy();
});

test("signOut wins a race against an in-flight forced refresh (proxy)", async () => {
  const convex = createConvexMock();

  let releaseRefresh!: () => void;
  const refreshGate = new Promise<void>((resolve) => {
    releaseRefresh = resolve;
  });
  const proxyFetch = vi.fn(async (body: Record<string, unknown>) => {
    if ((body.args as { refreshToken?: boolean } | undefined)?.refreshToken) {
      await refreshGate;
      return jsonResponse({
        kind: "signedIn",
        session: { token: "token-B", refreshToken: "dummy" },
      });
    }
    // signOut proxy call
    return jsonResponse({ ok: true });
  });

  const auth = client({
    convex,
    proxyPath: "/api/auth",
    token: "token-A",
    runtime: { proxy: { fetch: proxyFetch } },
  });

  const fetchAccessToken = convex.latestFetchToken()!;
  const refreshPromise = fetchAccessToken({ forceRefreshToken: true });
  await flushMicrotasks();

  await auth.signOut();
  expect(auth.getSnapshot()).toEqual({ status: "signedOut", token: null });

  releaseRefresh();
  await refreshPromise;

  expect(auth.getSnapshot()).toEqual({ status: "signedOut", token: null });

  auth.destroy();
});

// ---------------------------------------------------------------------------
// 2a. handshake-timeout trap -> signed-out instead of stuck loading
// ---------------------------------------------------------------------------

test("a handshake timeout resolves to signed-out, not a stuck loading state", async () => {
  vi.useFakeTimers();
  const convex = createConvexMock();
  const auth = client({
    convex,
    proxyPath: "/api/auth",
    token: "existing-token",
    runtime: {
      proxy: {
        fetch: async () =>
          jsonResponse({
            kind: "signedIn",
            session: { token: "fresh-token", refreshToken: "dummy" },
          }),
      },
    },
  });

  const signInPromise = auth.signIn("password", {
    email: "sarah@gmail.com",
    password: "44448888",
    flow: "signIn",
  });

  // eslint-disable-next-line jest/valid-expect -- handler must be attached before advancing timers
  const rejection = expect(signInPromise).rejects.toSatisfy(
    (error: unknown) =>
      error instanceof ConvexError && error.data?.code === "AUTH_HANDSHAKE_TIMEOUT",
  );

  // No Convex confirmation ever arrives.
  await vi.advanceTimersByTimeAsync(5001);
  await rejection;

  // The old behavior left `handshakePending` set and spun the UI in `loading`
  // forever. It must now be resolved to signed-out.
  expect(auth.getSnapshot()).toEqual({ status: "signedOut", token: null });

  auth.destroy();
  vi.useRealTimers();
});

// ---------------------------------------------------------------------------
// 2b. confirmed -> false: transient tolerated, real deauth signs out
// ---------------------------------------------------------------------------

test("a transient mid-rotation false keeps the confirmed session", async () => {
  const convex = createConvexMock();
  const storage = createSyncStorage({ jwt: "stored-token", refresh: "stored-refresh" });
  const auth = client({
    convex,
    api: { signIn: {} as never, signOut: {} as never },
    url: CONVEX_URL,
    storage,
  });

  expect(auth.getSnapshot()).toEqual({ status: "signedIn", token: "stored-token" });
  convex.triggerAuthChange(true);

  // A brief false during token rotation must not flip the UI out of signed-in.
  convex.triggerAuthChange(false);
  expect(auth.getSnapshot()).toEqual({ status: "signedIn", token: "stored-token" });

  // A confirming true clears the grace window; still signed in.
  convex.triggerAuthChange(true);
  expect(auth.getSnapshot()).toEqual({ status: "signedIn", token: "stored-token" });

  auth.destroy();
});

test("a confirmed session that stays unauthenticated signs out after the grace window", async () => {
  vi.useFakeTimers();
  const convex = createConvexMock();
  const storage = createSyncStorage({ jwt: "stored-token", refresh: "stored-refresh" });
  const auth = client({
    convex,
    api: { signIn: {} as never, signOut: {} as never },
    url: CONVEX_URL,
    storage,
  });
  await auth.initialize();

  expect(auth.getSnapshot()).toEqual({ status: "signedIn", token: "stored-token" });
  convex.triggerAuthChange(true);

  // Convex reports the confirmed session as unauthenticated and never recovers
  // (a server-side revoke / expiry). During the grace window we still show
  // signed-in...
  convex.triggerAuthChange(false);
  expect(auth.getSnapshot()).toEqual({ status: "signedIn", token: "stored-token" });

  // ...but once it elapses with no confirming `true`, we sign out.
  await vi.advanceTimersByTimeAsync(5001);
  expect(auth.getSnapshot()).toEqual({ status: "signedOut", token: null });
  expect(storage.map.get("__convexAuthJWT")).toBeUndefined();

  auth.destroy();
  vi.useRealTimers();
});

// ---------------------------------------------------------------------------
// 3. refresh-failure handling
// ---------------------------------------------------------------------------

test("a transient network error during forced refresh keeps the session (non-proxy)", async () => {
  const convex = createConvexMock();
  const storage = createSyncStorage({ jwt: "token-A", refresh: "refresh-A" });
  const httpClient = {
    action: vi.fn(async () => {
      throw new TypeError("Failed to fetch");
    }),
  };
  const auth = client({
    convex,
    api: { signIn: {} as never, signOut: {} as never },
    url: CONVEX_URL,
    storage,
    httpClient,
  });

  const fetchAccessToken = convex.latestFetchToken()!;
  const result = await fetchAccessToken({ forceRefreshToken: true });

  // The stale token is retained and the stored refresh token is NOT deleted, so
  // a later forced refresh can recover instead of signing the user out.
  expect(result).toBe("token-A");
  expect(auth.getSnapshot()).toEqual({ status: "signedIn", token: "token-A" });
  expect(storage.map.get("__convexAuthJWT")).toBe("token-A");
  expect(storage.map.get("__convexAuthRefreshToken")).toBe("refresh-A");
  // 1 initial attempt + RETRY_MAX_RETRIES (2) = 3 exchange attempts.
  expect(httpClient.action).toHaveBeenCalledTimes(3);

  auth.destroy();
});

test("an invalid-refresh rejection during forced refresh signs out (non-proxy)", async () => {
  const convex = createConvexMock();
  const storage = createSyncStorage({ jwt: "token-A", refresh: "refresh-A" });
  const httpClient = {
    action: vi.fn(async () => {
      throw new ConvexError({ code: "INVALID_REFRESH_TOKEN", message: "Invalid refresh token" });
    }),
  };
  const auth = client({
    convex,
    api: { signIn: {} as never, signOut: {} as never },
    url: CONVEX_URL,
    storage,
    httpClient,
  });

  const fetchAccessToken = convex.latestFetchToken()!;
  const result = await fetchAccessToken({ forceRefreshToken: true });

  expect(result).toBeNull();
  expect(auth.getSnapshot()).toEqual({ status: "signedOut", token: null });
  expect(storage.map.get("__convexAuthJWT")).toBeUndefined();
  expect(storage.map.get("__convexAuthRefreshToken")).toBeUndefined();
  // A rejection is not retried.
  expect(httpClient.action).toHaveBeenCalledTimes(1);

  auth.destroy();
});

test("a proxy 401 during forced refresh signs out and breaks the re-force-refresh loop", async () => {
  const convex = createConvexMock();
  const proxyFetch = vi.fn(async () => jsonResponse({ error: "unauthorized" }, 401));
  const auth = client({
    convex,
    proxyPath: "/api/auth",
    token: "existing-token",
    runtime: { proxy: { fetch: proxyFetch } },
  });

  const fetchAccessToken = convex.latestFetchToken()!;
  const result = await fetchAccessToken({ forceRefreshToken: true });

  // The stale token is NOT retained (which would trigger Convex to re-force-
  // refresh into a 401 loop) — the session is cleared.
  expect(result).toBeNull();
  expect(auth.getSnapshot()).toEqual({ status: "signedOut", token: null });
  // A 401 is not retriable, so exactly one exchange was attempted.
  expect(proxyFetch).toHaveBeenCalledTimes(1);

  auth.destroy();
});

// ---------------------------------------------------------------------------
// 4. SSR token seed surfaced synchronously (what React getServerSnapshot returns)
// ---------------------------------------------------------------------------

test("an explicit SSR token seed is exposed synchronously by getSnapshot", () => {
  // React's `getServerSnapshot` now returns `client.getSnapshot()` instead of a
  // hardcoded LOADING, so the server-rendered markup honors these seeds.
  const signedIn = client({
    convex: createConvexMock(),
    api: { signIn: {} as never, signOut: {} as never },
    url: CONVEX_URL,
    token: "server-token",
  });
  expect(signedIn.getSnapshot()).toEqual({ status: "signedIn", token: "server-token" });
  signedIn.destroy();

  const signedOut = client({
    convex: createConvexMock(),
    api: { signIn: {} as never, signOut: {} as never },
    url: CONVEX_URL,
    token: null,
  });
  expect(signedOut.getSnapshot()).toEqual({ status: "signedOut", token: null });
  signedOut.destroy();
});

test("an empty-string SSR token boots signed out instead of throwing", () => {
  // A cleared auth cookie surfaces as "" during SSR; it must not crash render.
  const auth = client({
    convex: createConvexMock(),
    api: { signIn: {} as never, signOut: {} as never },
    url: CONVEX_URL,
    token: "",
  });
  expect(auth.getSnapshot()).toEqual({ status: "signedOut", token: null });
  auth.destroy();
});

// ---------------------------------------------------------------------------
// 5. cross-tab storage sync: identity check + no flicker
// ---------------------------------------------------------------------------

test("a cross-tab token for the same subject is adopted without a loading flicker", async () => {
  const convex = createConvexMock();
  const tokenA1 = makeJwt("user-A", { iat: 1 });
  const tokenA2 = makeJwt("user-A", { iat: 2 });
  const storage = createSyncStorage({ jwt: tokenA1, refresh: "refresh-A" });

  let syncCallback: ((value: string | null) => void) | null = null;
  const auth = client({
    convex,
    api: { signIn: {} as never, signOut: {} as never },
    url: CONVEX_URL,
    storage,
    runtime: {
      sync: {
        subscribe: (_key, cb) => {
          syncCallback = cb;
          return () => {
            syncCallback = null;
          };
        },
      },
    },
  });

  convex.triggerAuthChange(true);
  const seen: string[] = [];
  const unsubscribe = auth.subscribe((state) => seen.push(state.status));
  expect(auth.getSnapshot()).toEqual({ status: "signedIn", token: tokenA1 });

  // Another tab rotated the access token for the SAME user.
  syncCallback!(tokenA2);
  await flushMicrotasks();

  expect(auth.getSnapshot()).toEqual({ status: "signedIn", token: tokenA2 });
  // The in-memory rotation must not have flipped the UI through `loading`.
  expect(seen).not.toContain("loading");

  unsubscribe();
  auth.destroy();
});

test("a cross-tab token for a different subject is ignored", async () => {
  const convex = createConvexMock();
  const tokenA = makeJwt("user-A", { iat: 1 });
  const tokenB = makeJwt("user-B", { iat: 1 });
  const storage = createSyncStorage({ jwt: tokenA, refresh: "refresh-A" });

  let syncCallback: ((value: string | null) => void) | null = null;
  const auth = client({
    convex,
    api: { signIn: {} as never, signOut: {} as never },
    url: CONVEX_URL,
    storage,
    runtime: {
      sync: {
        subscribe: (_key, cb) => {
          syncCallback = cb;
          return () => {
            syncCallback = null;
          };
        },
      },
    },
  });

  convex.triggerAuthChange(true);
  expect(auth.getSnapshot()).toEqual({ status: "signedIn", token: tokenA });

  // A confirmed tab must not silently adopt a different user's identity.
  syncCallback!(tokenB);
  await flushMicrotasks();

  expect(auth.getSnapshot()).toEqual({ status: "signedIn", token: tokenA });

  auth.destroy();
});

// ---------------------------------------------------------------------------
// 8. destroy() rejects in-flight handshakes and clears their timers
// ---------------------------------------------------------------------------

test("destroy rejects an in-flight sign-in handshake", async () => {
  const convex = createConvexMock();
  const auth = client({
    convex,
    proxyPath: "/api/auth",
    token: "existing-token",
    runtime: {
      proxy: {
        fetch: async () =>
          jsonResponse({
            kind: "signedIn",
            session: { token: "fresh-token", refreshToken: "dummy" },
          }),
      },
    },
  });

  const signInPromise = auth.signIn("password", {
    email: "sarah@gmail.com",
    password: "44448888",
    flow: "signIn",
  });

  const rejection = expect(signInPromise).rejects.toSatisfy(
    (error: unknown) =>
      error instanceof ConvexError && error.data?.code === "AUTH_HANDSHAKE_REJECTED",
  );

  // Let the sign-in reach its handshake wait, then tear down. destroy() rejects
  // the in-flight waiter (with reason "destroyed", not a timeout) and clears its
  // timer, so nothing leaks across an unmount / HMR.
  await flushMicrotasks();
  auth.destroy();
  await rejection;
});
