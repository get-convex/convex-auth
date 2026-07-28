// @vitest-environment jsdom
import { afterEach, describe, expect, test, vi } from "vitest";
import { getFunctionName, makeFunctionReference } from "convex/server";
import { ConvexError } from "convex/values";
import type { MutationCaller } from "../browser/providerSetup";
import { AuthClient } from "../browser/sessionManager";
import {
  InMemoryStorage,
  NamespacedStorage,
  type TokenStorage,
} from "../browser/storage";
import type { TokenBundle } from "../lib/types";
import {
  OAUTH_ACTIONS_STORE_KEY,
  OAUTH_FLOW_ERROR_STORE_KEY,
  oauth,
  type OauthActions,
  type OauthFlowError,
  type OauthProviderRefs,
} from "./client";

const NAMESPACE = "https://happy-animal-123.convex.cloud";

const bundle: TokenBundle = {
  accessToken: "access-1",
  accessTokenExpiresAt: 0,
  refreshToken: "refresh-1",
  refreshTokenExpiresAt: 0,
  userId: "user-1",
};

// Real function references (they carry their path), the way an app picks them
// off its generated `api.auth`. The start leg passes `startSignIn` through by
// identity; the completion leg rebuilds `completeSignIn` from the persisted
// path, so completion assertions compare paths via `getFunctionName`.
const googleStart = makeFunctionReference<"mutation">("auth:startSignInGoogle");
const googleComplete = makeFunctionReference<"mutation">(
  "auth:completeSignInGoogle",
);
const GOOGLE_REFS: OauthProviderRefs = {
  providerName: "google",
  startSignIn: googleStart,
  completeSignIn: googleComplete,
};

/** Store a pending flow the way `signIn` would before navigating away. */
function seedPendingFlow(
  storage: TokenStorage,
  {
    providerName = "google",
    state = "state-1",
    completeSignIn = "auth:completeSignInGoogle",
  } = {},
) {
  void new NamespacedStorage(storage, NAMESPACE).set(
    "__convexAuthOauthFlow",
    JSON.stringify({ providerName, state, completeSignIn }),
  );
}

/**
 * Run the oauth setup against a real AuthClient and a fake mutation caller,
 * the way `ConvexAuthProvider` would at client construction.
 */
function setupOAuth({ storage = new InMemoryStorage() as TokenStorage } = {}) {
  const client = new AuthClient({
    mode: "spa",
    authApi: { refreshSession: async () => null, signOut: async () => {} },
    storage,
    storageNamespace: NAMESPACE,
  });
  const mutation = vi.fn();
  const registration = oauth()({
    client,
    mutation: mutation as unknown as MutationCaller,
  }) as { onMount: () => void };
  const actions = client.store.get<OauthActions>(OAUTH_ACTIONS_STORE_KEY)!;
  const flowError = () =>
    client.store.get<OauthFlowError | null>(OAUTH_FLOW_ERROR_STORE_KEY);
  return {
    client,
    mutation,
    onMount: registration.onMount,
    actions,
    flowError,
    storage,
  };
}

/** The function path the fake `mutation` was called with. */
function calledPath(mutation: ReturnType<typeof vi.fn>, call = 0): string {
  return getFunctionName(mutation.mock.calls[call]![0] as never);
}

describe("OAuth client", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    window.history.replaceState(null, "", "/");
    // Restore the prototype getter shadowed by the React Native stub.
    delete (window.navigator as { product?: string }).product;
  });

  test("registers actions and a null flow error at setup", () => {
    const { actions, flowError } = setupOAuth();
    expect(actions.signIn).toBeTypeOf("function");
    expect(flowError()).toBeNull();
  });

  test("registering oauth() twice on one client throws", () => {
    const { client, mutation } = setupOAuth();
    expect(() =>
      oauth()({
        client,
        mutation: mutation as unknown as MutationCaller,
      }),
    ).toThrow(/registered twice/);
  });

  test("onMount redeems a callback code and adopts the session", async () => {
    window.history.replaceState(null, "", "/?convexAuthCode=code-1");
    const storage = new InMemoryStorage();
    seedPendingFlow(storage);
    const { client, mutation, onMount, flowError } = setupOAuth({ storage });
    mutation.mockResolvedValueOnce(bundle);

    onMount();

    await vi.waitFor(() =>
      expect(client.getSnapshot().isAuthenticated).toBe(true),
    );
    expect(mutation).toHaveBeenCalledOnce();
    // The reference is rebuilt from the persisted function path.
    expect(calledPath(mutation)).toBe("auth:completeSignInGoogle");
    expect(mutation.mock.calls[0]![1]).toEqual({
      code: "code-1",
      state: "state-1",
    });
    expect(client.getSnapshot().token).toBe("access-1");
    expect(flowError()).toBeNull();
    // The one-time code is stripped from the URL.
    expect(window.location.search).toBe("");
  });

  test("stripping the callback params keeps the history state", async () => {
    // Routers (React Router) keep their own entry state in `history.state`.
    window.history.replaceState({ idx: 3 }, "", "/?convexAuthCode=code-1");
    const storage = new InMemoryStorage();
    seedPendingFlow(storage);
    const { client, mutation, onMount } = setupOAuth({ storage });
    mutation.mockResolvedValueOnce(bundle);

    onMount();

    await vi.waitFor(() =>
      expect(client.getSnapshot().isAuthenticated).toBe(true),
    );
    expect(window.location.search).toBe("");
    expect(window.history.state).toEqual({ idx: 3 });
  });

  test("reports loading while a code is redeemed, through init resolving", async () => {
    window.history.replaceState(null, "", "/?convexAuthCode=code-1");
    const storage = new InMemoryStorage();
    seedPendingFlow(storage);
    const { client, mutation, onMount } = setupOAuth({ storage });
    const { promise, resolve } = Promise.withResolvers<TokenBundle>();
    mutation.mockReturnValueOnce(promise);

    // The real mount ordering: onMount latches synchronously, then init runs.
    onMount();
    expect(client.getSnapshot().isLoading).toBe(true);
    await client.init();
    expect(client.getSnapshot().isLoading).toBe(true);

    resolve(bundle);
    await vi.waitFor(() =>
      expect(client.getSnapshot().isAuthenticated).toBe(true),
    );
    expect(client.getSnapshot().isLoading).toBe(false);
  });

  test("a second onMount run finds a clean URL and no-ops", async () => {
    window.history.replaceState(null, "", "/?convexAuthCode=code-1");
    const storage = new InMemoryStorage();
    seedPendingFlow(storage);
    const { client, mutation, onMount } = setupOAuth({ storage });
    mutation.mockResolvedValueOnce(bundle);

    onMount();
    onMount();

    await vi.waitFor(() =>
      expect(client.getSnapshot().isAuthenticated).toBe(true),
    );
    expect(mutation).toHaveBeenCalledTimes(1);
  });

  test("a callback error param sets the flow error and strips the URL", () => {
    window.history.replaceState(null, "", "/?convexAuthError=access_denied");
    const { mutation, onMount, flowError } = setupOAuth();

    onMount();

    // The library owns default copy for each code; apps rebrand by switching
    // on `code` and ignoring `message`.
    expect(flowError()).toEqual({
      code: "access_denied",
      message: "Sign-in was cancelled.",
    });
    expect(mutation).not.toHaveBeenCalled();
    expect(window.location.search).toBe("");
  });

  test("a callback error consumes the pending flow", async () => {
    window.history.replaceState(null, "", "/?convexAuthError=access_denied");
    const storage = new InMemoryStorage();
    seedPendingFlow(storage);
    const { onMount, flowError } = setupOAuth({ storage });

    onMount();

    expect(flowError()?.code).toBe("access_denied");
    // The flow ended in an error, so the stored state can never complete.
    await vi.waitFor(() =>
      expect(
        new NamespacedStorage(storage, NAMESPACE).get("__convexAuthOauthFlow"),
      ).toBeNull(),
    );
  });

  test("an unknown error param normalizes to oauth_error", () => {
    window.history.replaceState(null, "", "/?convexAuthError=server_exploded");
    const { onMount, flowError } = setupOAuth();

    onMount();

    expect(flowError()?.code).toBe("oauth_error");
  });

  test("a code without a pending flow sets invalid_flow", async () => {
    window.history.replaceState(null, "", "/?convexAuthCode=code-1");
    const { client, mutation, onMount, flowError } = setupOAuth();

    onMount();
    await client.init();

    await vi.waitFor(() => expect(flowError()?.code).toBe("invalid_flow"));
    expect(mutation).not.toHaveBeenCalled();
    expect(client.getSnapshot().isLoading).toBe(false);
    expect(client.getSnapshot().isAuthenticated).toBe(false);
  });

  test("a pending flow without a completeSignIn path is invalid", async () => {
    // A record persisted by an older client (or tampered with) that lacks the
    // function path can't be completed — it must not crash or half-redeem.
    window.history.replaceState(null, "", "/?convexAuthCode=code-1");
    const storage = new InMemoryStorage();
    void new NamespacedStorage(storage, NAMESPACE).set(
      "__convexAuthOauthFlow",
      JSON.stringify({ providerName: "google", state: "state-1" }),
    );
    const { client, mutation, onMount, flowError } = setupOAuth({ storage });

    onMount();
    await client.init();

    await vi.waitFor(() => expect(flowError()?.code).toBe("invalid_flow"));
    expect(mutation).not.toHaveBeenCalled();
  });

  test("a null bundle sets expired", async () => {
    window.history.replaceState(null, "", "/?convexAuthCode=code-1");
    const storage = new InMemoryStorage();
    seedPendingFlow(storage);
    const { client, mutation, onMount, flowError } = setupOAuth({ storage });
    mutation.mockResolvedValueOnce(null);

    onMount();

    await vi.waitFor(() => expect(flowError()?.code).toBe("expired"));
    expect(client.getSnapshot().isAuthenticated).toBe(false);
  });

  test("a failed redemption sets oauth_error", async () => {
    // Also the dangling-path case: a persisted function path whose export was
    // renamed mid-flight fails the call the same way.
    window.history.replaceState(null, "", "/?convexAuthCode=code-1");
    const storage = new InMemoryStorage();
    seedPendingFlow(storage);
    const { client, mutation, onMount, flowError } = setupOAuth({ storage });
    mutation.mockRejectedValueOnce(new Error("boom"));

    onMount();
    await client.init();

    await vi.waitFor(() => expect(flowError()?.code).toBe("oauth_error"));
    expect(client.getSnapshot().isLoading).toBe(false);
  });

  test("an app rejection surfaces its ConvexError copy as rejected", async () => {
    window.history.replaceState(null, "", "/?convexAuthCode=code-1");
    const storage = new InMemoryStorage();
    seedPendingFlow(storage);
    const { client, mutation, onMount, flowError } = setupOAuth({ storage });
    mutation.mockRejectedValueOnce(
      new ConvexError("A verified email is required to sign in"),
    );

    onMount();
    await client.init();

    await vi.waitFor(() =>
      expect(flowError()).toEqual({
        code: "rejected",
        message: "A verified email is required to sign in",
      }),
    );
    expect(client.getSnapshot().isAuthenticated).toBe(false);
  });

  test("an app rejection with non-string data gets the default copy", async () => {
    window.history.replaceState(null, "", "/?convexAuthCode=code-1");
    const storage = new InMemoryStorage();
    seedPendingFlow(storage);
    const { mutation, onMount, flowError } = setupOAuth({ storage });
    mutation.mockRejectedValueOnce(new ConvexError({ reason: "policy" }));

    onMount();

    await vi.waitFor(() => expect(flowError()?.code).toBe("rejected"));
    expect(flowError()?.message).toBe("Sign-in was declined.");
  });

  test("a rejecting storage during redemption sets oauth_error", async () => {
    window.history.replaceState(null, "", "/?convexAuthCode=code-1");
    // Reject only the pending-flow read (an RN-style async storage failing);
    // the client's own token reads stay healthy.
    const storage: TokenStorage = {
      getItem: (key) =>
        key.startsWith("__convexAuthOauthFlow")
          ? Promise.reject(new Error("storage broken"))
          : null,
      setItem: () => {},
      removeItem: () => {},
    };
    const { client, mutation, onMount, flowError } = setupOAuth({ storage });

    onMount();
    await client.init();

    await vi.waitFor(() => expect(flowError()?.code).toBe("oauth_error"));
    expect(mutation).not.toHaveBeenCalled();
    expect(client.getSnapshot().isLoading).toBe(false);
  });

  test("a rejecting storage during error cleanup keeps the flow error", async () => {
    window.history.replaceState(null, "", "/?convexAuthError=access_denied");
    const storage: TokenStorage = {
      getItem: () => null,
      setItem: () => {},
      removeItem: () => Promise.reject(new Error("storage broken")),
    };
    const { onMount, flowError } = setupOAuth({ storage });

    onMount();

    expect(flowError()?.code).toBe("access_denied");
    // Give the voided cleanup a beat to settle — a rejection escaping it
    // would fail the run as unhandled.
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(flowError()?.code).toBe("access_denied");
  });

  test("signIn starts a flow, persists it, and returns the redirect", async () => {
    // The React Native branch returns the URL instead of navigating, which
    // also keeps jsdom (no navigation support) happy.
    Object.defineProperty(window.navigator, "product", {
      value: "ReactNative",
      configurable: true,
    });
    const { mutation, actions, storage } = setupOAuth();
    mutation.mockResolvedValueOnce({
      redirect: "https://provider.example/auth?client_id=x",
      state: "state-1",
    });

    const outcome = await actions.signIn(GOOGLE_REFS, {
      redirectTo: "http://localhost/app",
    });

    expect(mutation).toHaveBeenCalledExactlyOnceWith(googleStart, {
      redirectTo: "http://localhost/app",
    });
    expect(outcome).toEqual({
      redirect: new URL("https://provider.example/auth?client_id=x"),
    });
    // The persisted flow carries the completeSignIn function path, so
    // completion can run on a page that never held the references.
    expect(
      new NamespacedStorage(storage, NAMESPACE).get("__convexAuthOauthFlow"),
    ).toBe(
      JSON.stringify({
        providerName: "google",
        state: "state-1",
        completeSignIn: "auth:completeSignInGoogle",
      }),
    );
  });

  test("signIn with a code completes the pending flow", async () => {
    const storage = new InMemoryStorage();
    seedPendingFlow(storage);
    const { client, mutation, actions } = setupOAuth({ storage });
    mutation.mockResolvedValueOnce(bundle);

    const outcome = await actions.signIn(GOOGLE_REFS, { code: "code-1" });

    expect(outcome).toEqual({ signedIn: true });
    expect(mutation).toHaveBeenCalledOnce();
    expect(calledPath(mutation)).toBe("auth:completeSignInGoogle");
    expect(mutation.mock.calls[0]![1]).toEqual({
      code: "code-1",
      state: "state-1",
    });
    expect(client.getSnapshot().isAuthenticated).toBe(true);
  });

  test("signIn clears a previous flow error", async () => {
    window.history.replaceState(null, "", "/?convexAuthError=access_denied");
    Object.defineProperty(window.navigator, "product", {
      value: "ReactNative",
      configurable: true,
    });
    const { mutation, onMount, actions, flowError } = setupOAuth();
    onMount();
    expect(flowError()?.code).toBe("access_denied");

    mutation.mockResolvedValueOnce({
      redirect: "https://provider.example/auth",
      state: "state-2",
    });
    await actions.signIn(GOOGLE_REFS);

    expect(flowError()).toBeNull();
  });

  test("a failed start sets the flow error and rejects", async () => {
    const { mutation, actions, flowError, storage } = setupOAuth();
    mutation.mockRejectedValueOnce(new Error("boom"));

    await expect(actions.signIn(GOOGLE_REFS)).rejects.toThrow("boom");

    // The store carries the feedback even when the caller ignores the
    // rejection (the fire-and-forget click handler case).
    expect(flowError()?.code).toBe("oauth_error");
    expect(
      new NamespacedStorage(storage, NAMESPACE).get("__convexAuthOauthFlow"),
    ).toBeNull();
  });

  test("a rejected start surfaces the app's copy and rejects", async () => {
    const { mutation, actions, flowError } = setupOAuth();
    mutation.mockRejectedValueOnce(new ConvexError("Sign-ups are closed"));

    await expect(actions.signIn(GOOGLE_REFS)).rejects.toThrow();

    expect(flowError()).toEqual({
      code: "rejected",
      message: "Sign-ups are closed",
    });
  });

  test("a foreign code/error param is ignored and left in the URL", () => {
    window.history.replaceState(null, "", "/?code=foreign&error=foreign");
    const { mutation, onMount, flowError } = setupOAuth();

    onMount();

    // Only namespaced params are ours; a plain code/error belongs to the app.
    expect(mutation).not.toHaveBeenCalled();
    expect(flowError()).toBeNull();
    expect(window.location.search).toBe("?code=foreign&error=foreign");
  });
});
