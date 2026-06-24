// @vitest-environment jsdom
import { beforeEach, describe, expect, test, vi } from "vitest";
import type { TokenBundle } from "../../lib/tokens.js";
import {
  ensureFreshAccessToken,
  isAccessTokenExpired,
  REFRESH_SKEW_MS,
} from "./shared.js";

// The browser client persists the session under this key; tests seed it before
// the module loads (the store reads localStorage once at import) and assert on
// it afterward.
const STORAGE_KEY = "convexAuth.session";

function bundle(overrides: Partial<TokenBundle> = {}): TokenBundle {
  const now = Date.now();
  return {
    accessToken: "access-1",
    accessTokenExpiresAt: now + 60_000,
    refreshToken: "refresh-1",
    refreshTokenExpiresAt: now + 30 * 24 * 60 * 60 * 1000,
    userId: "user-1",
    ...overrides,
  };
}

function seedStoredTokens(tokens: TokenBundle | null) {
  if (tokens) localStorage.setItem(STORAGE_KEY, JSON.stringify(tokens));
  else localStorage.removeItem(STORAGE_KEY);
}

function stored(): TokenBundle | null {
  const raw = localStorage.getItem(STORAGE_KEY);
  return raw ? (JSON.parse(raw) as TokenBundle) : null;
}

// A stand-in for the Convex client: only `.mutation` / `.action` are used. The
// mutation handlers are keyed by the reference name the tests pass for each
// mutation ("refresh" / "signOut"), so call sites read clearly; an unhandled
// reference resolves to null.
function makeClient(
  handlers: {
    refresh?: (args: { refreshToken: string }) => Promise<TokenBundle | null>;
    signOut?: (args: { refreshToken: string }) => Promise<null>;
  } = {},
) {
  return {
    mutation: vi.fn((ref: unknown, args: { refreshToken: string }) => {
      if (ref === "refresh")
        return (handlers.refresh ?? (async () => null))(args);
      if (ref === "signOut")
        return (handlers.signOut ?? (async () => null))(args);
      return Promise.resolve(null);
    }),
    action: vi.fn(),
  };
}

// Load a *fresh* copy of the client module (and a matching React +
// testing-library, so all three share one module graph). `vi.resetModules()`
// in `beforeEach` resets the module-global token store and the redirect
// one-shot between tests.
async function load() {
  const React = await import("react");
  const { renderHook, act } = await import("@testing-library/react/pure");
  const client = await import("./client.js");
  return { React, renderHook, act, ...client };
}

beforeEach(() => {
  localStorage.clear();
  vi.resetModules();
});

// Render `useAuth` inside an `<AuthProvider>` wired to `client`.
function renderUseAuth(
  m: Awaited<ReturnType<typeof load>>,
  client: ReturnType<typeof makeClient>,
  props: Record<string, unknown> = {},
) {
  const { React, renderHook, AuthProvider, useAuth } = m;
  const wrapper = ({ children }: { children?: unknown }) =>
    React.createElement(
      AuthProvider as never,
      {
        client,
        refreshMutation: "refresh",
        signOutMutation: "signOut",
        ...props,
      } as never,
      children as never,
    );
  return renderHook(() => useAuth(), { wrapper });
}

describe("useAuth().fetchAccessToken", () => {
  test("fast path returns the stored token without refreshing", async () => {
    seedStoredTokens(bundle());
    const m = await load();
    const client = makeClient();
    const { result } = renderUseAuth(m, client);

    expect(result.current.isAuthenticated).toBe(true);
    let token: string | null = null;
    await m.act(async () => {
      token = await result.current.fetchAccessToken({
        forceRefreshToken: false,
      });
    });

    expect(token).toBe("access-1");
    expect(client.mutation).not.toHaveBeenCalled();
  });

  test("refreshes an expired token and persists the rotated bundle", async () => {
    seedStoredTokens(bundle({ accessTokenExpiresAt: Date.now() - 1000 }));
    const rotated = bundle({
      accessToken: "access-2",
      refreshToken: "refresh-2",
    });
    const m = await load();
    const client = makeClient({ refresh: async () => rotated });
    const { result } = renderUseAuth(m, client);

    let token: string | null = null;
    await m.act(async () => {
      token = await result.current.fetchAccessToken({
        forceRefreshToken: false,
      });
    });

    expect(token).toBe("access-2");
    expect(client.mutation).toHaveBeenCalledTimes(1);
    expect(client.mutation).toHaveBeenCalledWith("refresh", {
      refreshToken: "refresh-1",
    });
    expect(stored()?.accessToken).toBe("access-2");
    expect(stored()?.refreshToken).toBe("refresh-2");
    expect(result.current.isAuthenticated).toBe(true);
  });

  test("clears the session when refresh returns null (dead session)", async () => {
    seedStoredTokens(bundle({ accessTokenExpiresAt: Date.now() - 1000 }));
    const m = await load();
    const client = makeClient({ refresh: async () => null });
    const { result } = renderUseAuth(m, client);

    let token: string | null = "unset";
    await m.act(async () => {
      token = await result.current.fetchAccessToken({
        forceRefreshToken: false,
      });
    });

    expect(token).toBeNull();
    expect(client.mutation).toHaveBeenCalledTimes(1);
    expect(stored()).toBeNull();
    expect(result.current.isAuthenticated).toBe(false);
  });

  test("keeps the session when a refresh throws, propagating for a later retry", async () => {
    seedStoredTokens(bundle({ accessTokenExpiresAt: Date.now() - 1000 }));
    const m = await load();
    const client = makeClient({
      refresh: async () => {
        throw new Error("boom");
      },
    });
    const { result } = renderUseAuth(m, client);

    // A non-`null` failure may be transient: the session is left intact so a
    // later attempt can recover, rather than signing the user out.
    await m.act(async () => {
      await expect(
        result.current.fetchAccessToken({ forceRefreshToken: false }),
      ).rejects.toThrow("boom");
    });

    expect(stored()?.refreshToken).toBe("refresh-1");
    expect(result.current.isAuthenticated).toBe(true);
  });

  test("retries a refresh that fails with a network error", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout"] });
    try {
      seedStoredTokens(bundle({ accessTokenExpiresAt: Date.now() - 1000 }));
      const rotated = bundle({ accessToken: "access-2" });
      let calls = 0;
      const m = await load();
      const client = makeClient({
        refresh: async () => {
          calls += 1;
          if (calls === 1) throw new TypeError("Failed to fetch");
          return rotated;
        },
      });
      const { result } = renderUseAuth(m, client);

      let token: string | null = null;
      await m.act(async () => {
        const pending = result.current.fetchAccessToken({
          forceRefreshToken: false,
        });
        await vi.runAllTimersAsync();
        token = await pending;
      });

      // The first (network) failure is retried and the second attempt succeeds.
      expect(calls).toBe(2);
      expect(token).toBe("access-2");
      expect(stored()?.accessToken).toBe("access-2");
    } finally {
      vi.useRealTimers();
    }
  });

  test("a concurrent sign-out is not undone by an in-flight refresh", async () => {
    seedStoredTokens(bundle({ accessTokenExpiresAt: Date.now() - 1000 }));
    const rotated = bundle({
      accessToken: "access-2",
      refreshToken: "refresh-2",
    });
    let resolveRefresh!: (value: TokenBundle) => void;
    const gate = new Promise<TokenBundle>((resolve) => {
      resolveRefresh = resolve;
    });
    const m = await load();
    // The refresh mutation is gated; sign-out resolves immediately.
    const client = makeClient({
      refresh: () => gate,
      signOut: async () => null,
    });
    const { React, renderHook } = m;
    const wrapper = ({ children }: { children?: unknown }) =>
      React.createElement(
        m.AuthProvider as never,
        {
          client,
          refreshMutation: "refresh",
          signOutMutation: "signOut",
        } as never,
        children as never,
      );
    const { result } = renderHook(
      () => ({ auth: m.useAuth(), signOut: m.useSignOut() }),
      { wrapper },
    );

    let token: string | null = "unset";
    await m.act(async () => {
      const pending = result.current.auth.fetchAccessToken({
        forceRefreshToken: false,
      });
      // Sign out while the refresh is still in flight, then let it resolve.
      await result.current.signOut();
      resolveRefresh(rotated);
      token = await pending;
    });

    // The rotated bundle must not resurrect the signed-out session.
    expect(token).toBeNull();
    expect(stored()).toBeNull();
    expect(result.current.auth.isAuthenticated).toBe(false);
  });

  test("dedupes concurrent refreshes into a single rotation", async () => {
    seedStoredTokens(bundle({ accessTokenExpiresAt: Date.now() - 1000 }));
    const rotated = bundle({ accessToken: "access-2" });
    let resolveRefresh!: (value: TokenBundle) => void;
    const gate = new Promise<TokenBundle>((resolve) => {
      resolveRefresh = resolve;
    });
    const m = await load();
    const client = makeClient({ refresh: () => gate });
    const { result } = renderUseAuth(m, client);

    let t1: string | null = null;
    let t2: string | null = null;
    await m.act(async () => {
      const p1 = result.current.fetchAccessToken({ forceRefreshToken: false });
      const p2 = result.current.fetchAccessToken({ forceRefreshToken: false });
      resolveRefresh(rotated);
      [t1, t2] = await Promise.all([p1, p2]);
    });

    expect(t1).toBe("access-2");
    expect(t2).toBe("access-2");
    expect(client.mutation).toHaveBeenCalledTimes(1);
  });
});

describe("useSignOut", () => {
  test("clears the local session and revokes it server-side", async () => {
    seedStoredTokens(bundle());
    const m = await load();
    const client = makeClient({ signOut: async () => null });
    const { React, renderHook } = m;
    const wrapper = ({ children }: { children?: unknown }) =>
      React.createElement(
        m.AuthProvider as never,
        {
          client,
          refreshMutation: "refresh",
          signOutMutation: "signOut",
        } as never,
        children as never,
      );
    const { result } = renderHook(() => m.useSignOut(), { wrapper });

    await m.act(async () => {
      await result.current();
    });

    expect(stored()).toBeNull();
    expect(client.mutation).toHaveBeenCalledWith("signOut", {
      refreshToken: "refresh-1",
    });
  });
});

describe("redirect completion", () => {
  test("runs the matching handler exactly once and stores the session", async () => {
    const m = await load();
    const session = bundle({ accessToken: "redirect-token" });
    const complete = vi.fn(async () => session);
    const handler = { matches: () => true, complete };
    const client = makeClient();
    const { React, renderHook } = m;

    // Wrap in StrictMode so the effect is mounted twice; the one-shot guard must
    // still run `complete()` exactly once.
    const wrapper = ({ children }: { children?: unknown }) =>
      React.createElement(
        React.StrictMode,
        null,
        React.createElement(
          m.AuthProvider as never,
          {
            client,
            refreshMutation: "refresh",
            signOutMutation: "signOut",
            redirectHandlers: [handler],
          } as never,
          children as never,
        ),
      );
    const view = renderHook(() => m.useAuth(), { wrapper });
    await m.act(async () => {
      await new Promise((r) => setTimeout(r, 0));
    });

    expect(complete).toHaveBeenCalledTimes(1);
    expect(view.result.current.isAuthenticated).toBe(true);
    expect(view.result.current.isLoading).toBe(false);
    expect(stored()?.accessToken).toBe("redirect-token");

    // A later remount must not re-run the one-shot either.
    view.unmount();
    renderUseAuth(m, client, { redirectHandlers: [handler] });
    await m.act(async () => {
      await new Promise((r) => setTimeout(r, 0));
    });
    expect(complete).toHaveBeenCalledTimes(1);
  });

  test("surfaces a redirect failure via useRedirectError", async () => {
    const m = await load();
    const complete = vi.fn(async () => {
      throw new Error("bad state");
    });
    const handler = { matches: () => true, complete };
    const client = makeClient();
    const { React, renderHook } = m;
    const wrapper = ({ children }: { children?: unknown }) =>
      React.createElement(
        m.AuthProvider as never,
        {
          client,
          refreshMutation: "refresh",
          signOutMutation: "signOut",
          redirectHandlers: [handler],
        } as never,
        children as never,
      );
    const { result } = renderHook(
      () => ({ auth: m.useAuth(), error: m.useRedirectError() }),
      { wrapper },
    );

    await m.act(async () => {
      await new Promise((r) => setTimeout(r, 0));
    });

    expect(result.current.error).toBe("bad state");
    expect(result.current.auth.isLoading).toBe(false);
    expect(result.current.auth.isAuthenticated).toBe(false);
  });
});

// The freshness kernel is storage-agnostic, so its contract is checked
// directly here in addition to being exercised through the hook above.
describe("ensureFreshAccessToken", () => {
  const refreshUnused = async () => {
    throw new Error("refresh should not be called");
  };

  test("the skew window stays shorter than the default access TTL", () => {
    // A freshly minted token (default 60s TTL) must not already read as expired.
    expect(REFRESH_SKEW_MS).toBeLessThan(60_000);
    const now = Date.now();
    const fresh = bundle({ accessTokenExpiresAt: now + 60_000 });
    expect(isAccessTokenExpired(fresh, now)).toBe(false);
    // ...but a token inside the skew window is treated as expired.
    const nearExpiry = bundle({
      accessTokenExpiresAt: now + REFRESH_SKEW_MS - 1,
    });
    expect(isAccessTokenExpired(nearExpiry, now)).toBe(true);
  });

  test("fast path returns the same bundle reference without refreshing", async () => {
    const b = bundle();
    const result = await ensureFreshAccessToken({
      bundle: b,
      refresh: refreshUnused,
    });
    expect(result).toBe(b);
  });

  test("presents an expired token to the server (which reaps it) instead of short-circuiting", async () => {
    const dead = bundle({
      accessTokenExpiresAt: Date.now() - 1000,
      refreshTokenExpiresAt: Date.now() - 1000,
    });
    const refresh = vi.fn(async () => null);
    const result = await ensureFreshAccessToken({ bundle: dead, refresh });
    // Even a locally-expired refresh token is sent: the server deletes the dead
    // session as it rejects the token. The client clears on the resulting null.
    expect(refresh).toHaveBeenCalledWith(dead.refreshToken);
    expect(result).toBeNull();
  });

  test("force refreshes even when the access token is still valid", async () => {
    const rotated = bundle({ accessToken: "access-2" });
    const result = await ensureFreshAccessToken({
      bundle: bundle(),
      force: true,
      refresh: async () => rotated,
    });
    expect(result).toBe(rotated);
  });

  test("propagates a thrown refresh rather than clearing", async () => {
    await expect(
      ensureFreshAccessToken({
        bundle: bundle({ accessTokenExpiresAt: Date.now() - 1000 }),
        refresh: async () => {
          throw new Error("offline");
        },
      }),
    ).rejects.toThrow("offline");
  });

  test("a null refresh result clears the session", async () => {
    const result = await ensureFreshAccessToken({
      bundle: bundle({ accessTokenExpiresAt: Date.now() - 1000 }),
      refresh: async () => null,
    });
    expect(result).toBeNull();
  });
});
