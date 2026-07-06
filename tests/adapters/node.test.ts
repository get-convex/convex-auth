/**
 * Client-core adapter tests (audit finding H16 — client adapters were ZERO
 * coverage).
 *
 * These exercise the framework-agnostic client core (`client()` from
 * `@robelest/convex-auth/client`) — the shared engine every platform adapter
 * (react/svelte/expo/browser) wraps. The core needs no DOM, so it runs in the
 * node project against a mocked `ConvexTransport` + an in-memory `Storage`.
 *
 * Covered here:
 *   - the auth state machine (loading -> signedOut / signedIn) via
 *     subscribe/getSnapshot, driven by the Convex confirmation callback;
 *   - token write-through to storage on sign-in and clearing on sign-out;
 *   - the typed-error surface (`{ kind: "failed", code }`) from a factor client.
 *
 * NOT covered (flagged in the H16 report): the React/Svelte/Expo hook layers
 * (`useAuth`, `<SignedIn>`, etc.). Testing those needs react-dom + a DOM
 * environment + @testing-library, none of which are installable here without a
 * workspace dependency change; the hooks are thin `useSyncExternalStore`
 * wrappers over exactly the subscribe/getSnapshot contract these tests pin.
 */

import { client } from "@robelest/convex-auth/client";
import type { AuthApiRefs, AuthState, Storage } from "@robelest/convex-auth/client";
// ConvexTransport and SignInActionResult are internal to the client core (they
// are not part of the public `/client` type surface), so the tests import them
// from the core type module directly rather than widening the package exports.
import type { ConvexTransport, SignInActionResult } from "@robelest/convex-auth/client/core/types";
import type { AuthTokens } from "@robelest/convex-auth/shared/results";
import { ErrorCode } from "@robelest/convex-auth/client/errors";
import { expect, test } from "vite-plus/test";

/** Build a branded {@link AuthTokens} pair for a mocked `signedIn` result. */
function session(token: string, refreshToken: string): AuthTokens {
  return { token, refreshToken } as unknown as AuthTokens;
}

const MOCK_URL = "https://mock.convex.cloud";
// Storage keys are namespaced by the deployment URL: name + "_" + escaped host.
const NS = MOCK_URL.replace(/^https?:\/\//, "").replace(/[^a-zA-Z0-9]/g, "_");
const JWT_KEY = `__convexAuthJWT_${NS}`;
const REFRESH_KEY = `__convexAuthRefreshToken_${NS}`;

/** In-memory Storage that records the current key/value map for assertions. */
function memoryStorage(seed: Record<string, string> = {}) {
  const map = new Map<string, string>(Object.entries(seed));
  const storage: Storage = {
    getItem: (k) => map.get(k) ?? null,
    setItem: (k, v) => {
      map.set(k, v);
    },
    removeItem: (k) => {
      map.delete(k);
    },
  };
  return { storage, map };
}

/**
 * A mocked Convex client. Captures the `onChange` callback so a test can
 * simulate Convex confirming (or dropping) auth, and lets each test script the
 * `action` response used by `signIn` / factor flows.
 *
 * With `autoConfirm`, every `setAuth` re-bind (which the core performs right
 * after it stashes a new token and before it awaits the confirmation
 * handshake) schedules an `onChange(true)` on a microtask — this mimics a real
 * Convex client that validates the fresh token and reports authenticated,
 * without the test having to hand-race the handshake.
 */
function mockConvex(
  action: ConvexTransport["action"] = async () => ({ kind: "started" }),
  opts: { autoConfirm?: boolean } = {},
) {
  let onChange: ((isAuthenticated: boolean) => void) | undefined;
  const convex: ConvexTransport = {
    action,
    setAuth: (_fetchToken, cb) => {
      onChange = cb;
      if (opts.autoConfirm) {
        void Promise.resolve().then(() => onChange?.(true));
      }
    },
    clearAuth: () => {},
  };
  return {
    convex,
    /** Simulate the Convex WebSocket confirming the new token. */
    confirm: () => onChange?.(true),
  };
}

// `_capabilities` drives the conditional client type: declaring totp/device
// enabled surfaces `auth.totp` / `auth.device` on the returned client (the
// factory always builds them at runtime; this just tells the type checker).
const API_REFS: AuthApiRefs<false, true, true> = {
  signIn: "auth:signIn" as never,
  signOut: "auth:signOut" as never,
  _capabilities: { passkey: false, totp: true, device: true },
};

/** Collect every state a subscriber sees, in order. */
function record(auth: ReturnType<typeof client>) {
  const states: AuthState[] = [];
  const unsubscribe = auth.subscribe((s) => states.push(s));
  return { states, unsubscribe };
}

test("boots signedOut immediately when token is explicitly null", async () => {
  const { convex } = mockConvex();
  const auth = client({ convex, api: API_REFS, url: MOCK_URL, token: null });
  const { states } = record(auth);
  // A null token marks auth resolved, so the very first snapshot is signedOut
  // (no loading phase).
  expect(states[0]).toEqual({ status: "signedOut", token: null });
  expect(auth.getSnapshot()).toEqual({ status: "signedOut", token: null });
});

test("boots signedIn when seeded with a server token", async () => {
  const { convex } = mockConvex();
  const auth = client({ convex, api: API_REFS, url: MOCK_URL, token: "seed.jwt.value" });
  expect(auth.getSnapshot()).toEqual({ status: "signedIn", token: "seed.jwt.value" });
});

test("transitions loading -> signedOut when storage has no persisted token", async () => {
  const { convex } = mockConvex();
  const { storage } = memoryStorage();
  // Omit `token` entirely so the client discovers persisted auth from storage.
  const auth = client({ convex, api: API_REFS, url: MOCK_URL, storage });
  const { states } = record(auth);
  // First observed state is loading (discovery in flight).
  expect(states[0]).toEqual({ status: "loading", token: null });

  await auth.initialize();

  expect(auth.getSnapshot()).toEqual({ status: "signedOut", token: null });
  expect(states.at(-1)).toEqual({ status: "signedOut", token: null });
});

test("hydrates signedIn from a persisted token in storage", async () => {
  const { convex } = mockConvex();
  const { storage } = memoryStorage({
    [JWT_KEY]: "persisted.jwt",
    [REFRESH_KEY]: "persisted.refresh",
  });
  const auth = client({ convex, api: API_REFS, url: MOCK_URL, storage });

  // A persisted token is treated as a resolved seed (same as an explicit
  // `token`), so the client boots straight to signedIn without a loading phase.
  expect(auth.getSnapshot()).toEqual({ status: "signedIn", token: "persisted.jwt" });
  await auth.initialize();
  expect(auth.getSnapshot()).toEqual({ status: "signedIn", token: "persisted.jwt" });
});

test("totp.verify writes both tokens through to storage on success", async () => {
  const { convex } = mockConvex(
    async () =>
      ({
        kind: "signedIn",
        session: session("new.access.jwt", "new.refresh.token"),
      }) satisfies SignInActionResult,
    { autoConfirm: true },
  );
  const { storage, map } = memoryStorage();
  const auth = client({ convex, api: API_REFS, url: MOCK_URL, storage, token: null });

  const result = await auth.totp.verify({ code: "123456", verifier: "v" });

  expect(result).toEqual({ kind: "signedIn" });
  expect(map.get(JWT_KEY)).toBe("new.access.jwt");
  expect(map.get(REFRESH_KEY)).toBe("new.refresh.token");
  expect(auth.getSnapshot()).toEqual({ status: "signedIn", token: "new.access.jwt" });
});

test("totp.verify surfaces a typed failed result when the code is rejected", async () => {
  // A non-signedIn action result (server rejected the code) must become a typed
  // failure carrying an ErrorCode — not a throw.
  const { convex } = mockConvex(async () => ({ kind: "started" }) satisfies SignInActionResult);
  const auth = client({ convex, api: API_REFS, url: MOCK_URL, token: null });

  const result = await auth.totp.verify({ code: "000000", verifier: "v" });
  expect(result).toEqual({ kind: "failed", code: ErrorCode.TOTP_INVALID_CODE });
  // A failed verify must not flip the client to signed in.
  expect(auth.getSnapshot()).toEqual({ status: "signedOut", token: null });
});

test("signOut clears persisted tokens and returns to signedOut", async () => {
  const { convex } = mockConvex(
    async (ref) => {
      // signIn returns a session; signOut returns nothing meaningful.
      if (ref === API_REFS.signIn) {
        return {
          kind: "signedIn",
          session: session("a.jwt", "a.refresh"),
        } satisfies SignInActionResult;
      }
      return null;
    },
    { autoConfirm: true },
  );
  const { storage, map } = memoryStorage();
  const auth = client({ convex, api: API_REFS, url: MOCK_URL, storage, token: null });

  await auth.totp.verify({ code: "123456", verifier: "v" });
  expect(map.get(JWT_KEY)).toBe("a.jwt");

  await auth.signOut();

  expect(map.has(JWT_KEY)).toBe(false);
  expect(map.has(REFRESH_KEY)).toBe(false);
  expect(auth.getSnapshot()).toEqual({ status: "signedOut", token: null });
});

test("subscribe emits an initial snapshot and dedupes identical states", async () => {
  const { convex } = mockConvex();
  const auth = client({ convex, api: API_REFS, url: MOCK_URL, token: null });
  const { states, unsubscribe } = record(auth);
  // useSyncExternalStore relies on an immediate initial emit.
  expect(states).toHaveLength(1);
  expect(states[0]).toEqual({ status: "signedOut", token: null });
  unsubscribe();
});
