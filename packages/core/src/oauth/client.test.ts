// @vitest-environment jsdom
import { afterEach, describe, expect, test, vi } from "vitest";
import { getFunctionName, makeFunctionReference } from "convex/server";
import type { AuthSignInApi } from "../browser/providerSetup";
import { AuthClient } from "../browser/sessionManager";
import { InMemoryStorage, NamespacedStorage } from "../browser/storage";
import type { TokenBundle } from "../lib/types";
import {
  OAUTH_ACTIONS_KEY,
  OAUTH_FLOW_ERROR_KEY,
  OAUTH_SETUP_ID,
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

/** The oauth setup's scoped storage view over `storage`. */
function flowStorage(storage: InMemoryStorage) {
  return new NamespacedStorage(storage, NAMESPACE).scoped(OAUTH_SETUP_ID);
}

/** Store a pending flow the way `signIn` would before navigating away. */
function seedPendingFlow(
  storage: InMemoryStorage,
  {
    providerName = "google",
    state = "state-1",
    completeSignIn = "auth:completeSignInGoogle",
  } = {},
) {
  void flowStorage(storage).set(
    "flow",
    JSON.stringify({ providerName, state, completeSignIn }),
  );
}

/**
 * Run the oauth setup against a real AuthClient and a fake sign-in api. The
 * setup runs during client construction through a wrapper that keeps the
 * returned onInit away from the client and hands it to the test instead, so
 * tests drive the startup work by hand and `client.init()` won't also run it.
 */
function setupOAuth({ storage = new InMemoryStorage() } = {}) {
  const mutation = vi.fn();
  const signInApi = { mutation, action: vi.fn() } as unknown as AuthSignInApi;
  const captured: { onInit?: () => void } = {};
  const oauthSetup = oauth();
  const client = new AuthClient({
    mode: "spa",
    authApi: { refreshSession: async () => null, signOut: async () => {} },
    storage,
    storageNamespace: NAMESPACE,
    providerClients: {
      setups: [
        {
          id: oauthSetup.id,
          setup: (ctx) => {
            captured.onInit = oauthSetup.setup(ctx)?.onInit;
          },
        },
      ],
      signInApi,
    },
  });
  const oauthState = client.providerState(OAUTH_SETUP_ID);
  const actions = oauthState.get<OauthActions>(OAUTH_ACTIONS_KEY)!;
  const flowError = () =>
    oauthState.get<OauthFlowError | null>(OAUTH_FLOW_ERROR_KEY);
  return {
    client,
    mutation,
    onInit: captured.onInit!,
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

  test("registering oauth() twice on one provider throws", () => {
    const signInApi = {
      mutation: vi.fn(),
      action: vi.fn(),
    } as unknown as AuthSignInApi;
    expect(
      () =>
        new AuthClient({
          mode: "spa",
          authApi: {
            refreshSession: async () => null,
            signOut: async () => {},
          },
          storage: new InMemoryStorage(),
          storageNamespace: NAMESPACE,
          providerClients: { setups: [oauth(), oauth()], signInApi },
        }),
    ).toThrow(/registered twice/);
  });

  test("client.init runs the setup's onInit and completes a pending flow", async () => {
    // The real wiring, no capture wrapper: oauth() registered the way
    // `ConvexAuthProvider` does it, with init driving the startup work.
    window.history.replaceState(null, "", "/?convexAuthCode=code-1");
    const storage = new InMemoryStorage();
    seedPendingFlow(storage);
    const mutation = vi.fn().mockResolvedValueOnce(bundle);
    const signInApi = { mutation, action: vi.fn() } as unknown as AuthSignInApi;
    const client = new AuthClient({
      mode: "spa",
      authApi: { refreshSession: async () => null, signOut: async () => {} },
      storage,
      storageNamespace: NAMESPACE,
      providerClients: { setups: [oauth()], signInApi },
    });

    await client.init();

    await vi.waitFor(() =>
      expect(client.getSnapshot().isAuthenticated).toBe(true),
    );
    expect(mutation).toHaveBeenCalledOnce();
    expect(window.location.search).toBe("");
  });

  test("onInit redeems a callback code and adopts the session", async () => {
    window.history.replaceState(null, "", "/?convexAuthCode=code-1");
    const storage = new InMemoryStorage();
    seedPendingFlow(storage);
    const { client, mutation, onInit, flowError } = setupOAuth({ storage });
    mutation.mockResolvedValueOnce(bundle);

    onInit();

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
    const { client, mutation, onInit } = setupOAuth({ storage });
    mutation.mockResolvedValueOnce(bundle);

    onInit();

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
    const { client, mutation, onInit } = setupOAuth({ storage });
    const { promise, resolve } = Promise.withResolvers<TokenBundle>();
    mutation.mockReturnValueOnce(promise);

    // Mirror init's real ordering by hand. onInit marks sign-in pending
    // synchronously, then the session load runs.
    onInit();
    expect(client.getSnapshot().isLoading).toBe(true);
    await client.init();
    expect(client.getSnapshot().isLoading).toBe(true);

    resolve(bundle);
    await vi.waitFor(() =>
      expect(client.getSnapshot().isAuthenticated).toBe(true),
    );
    expect(client.getSnapshot().isLoading).toBe(false);
  });

  test("a second onInit run finds a clean URL and no-ops", async () => {
    window.history.replaceState(null, "", "/?convexAuthCode=code-1");
    const storage = new InMemoryStorage();
    seedPendingFlow(storage);
    const { client, mutation, onInit } = setupOAuth({ storage });
    mutation.mockResolvedValueOnce(bundle);

    onInit();
    onInit();

    await vi.waitFor(() =>
      expect(client.getSnapshot().isAuthenticated).toBe(true),
    );
    expect(mutation).toHaveBeenCalledTimes(1);
  });

  test("a callback error param sets the flow error and strips the URL", () => {
    window.history.replaceState(null, "", "/?convexAuthError=access_denied");
    const { mutation, onInit, flowError } = setupOAuth();

    onInit();

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
    const { onInit, flowError } = setupOAuth({ storage });

    onInit();

    expect(flowError()?.code).toBe("access_denied");
    // The flow ended in an error, so the stored state can never complete.
    await vi.waitFor(() => expect(flowStorage(storage).get("flow")).toBeNull());
  });

  test("an unknown error param normalizes to oauth_error", () => {
    window.history.replaceState(null, "", "/?convexAuthError=server_exploded");
    const { onInit, flowError } = setupOAuth();

    onInit();

    expect(flowError()?.code).toBe("oauth_error");
  });

  test("a code without a pending flow sets invalid_flow", async () => {
    window.history.replaceState(null, "", "/?convexAuthCode=code-1");
    const { client, mutation, onInit, flowError } = setupOAuth();

    onInit();
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
    void flowStorage(storage).set(
      "flow",
      JSON.stringify({ providerName: "google", state: "state-1" }),
    );
    const { client, mutation, onInit, flowError } = setupOAuth({ storage });

    onInit();
    await client.init();

    await vi.waitFor(() => expect(flowError()?.code).toBe("invalid_flow"));
    expect(mutation).not.toHaveBeenCalled();
  });

  test("a null bundle sets expired", async () => {
    window.history.replaceState(null, "", "/?convexAuthCode=code-1");
    const storage = new InMemoryStorage();
    seedPendingFlow(storage);
    const { client, mutation, onInit, flowError } = setupOAuth({ storage });
    mutation.mockResolvedValueOnce(null);

    onInit();

    await vi.waitFor(() => expect(flowError()?.code).toBe("expired"));
    expect(client.getSnapshot().isAuthenticated).toBe(false);
  });

  test("a failed redemption sets oauth_error", async () => {
    // Also the dangling-path case: a persisted function path whose export was
    // renamed mid-flight fails the call the same way.
    window.history.replaceState(null, "", "/?convexAuthCode=code-1");
    const storage = new InMemoryStorage();
    seedPendingFlow(storage);
    const { client, mutation, onInit, flowError } = setupOAuth({ storage });
    mutation.mockRejectedValueOnce(new Error("boom"));

    onInit();
    await client.init();

    await vi.waitFor(() => expect(flowError()?.code).toBe("oauth_error"));
    expect(client.getSnapshot().isLoading).toBe(false);
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
    expect(flowStorage(storage).get("flow")).toBe(
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
    const { mutation, onInit, actions, flowError } = setupOAuth();
    onInit();
    expect(flowError()?.code).toBe("access_denied");

    mutation.mockResolvedValueOnce({
      redirect: "https://provider.example/auth",
      state: "state-2",
    });
    await actions.signIn(GOOGLE_REFS);

    expect(flowError()).toBeNull();
  });

  test("a foreign code/error param is ignored and left in the URL", () => {
    window.history.replaceState(null, "", "/?code=foreign&error=foreign");
    const { mutation, onInit, flowError } = setupOAuth();

    onInit();

    // Only namespaced params are ours; a plain code/error belongs to the app.
    expect(mutation).not.toHaveBeenCalled();
    expect(flowError()).toBeNull();
    expect(window.location.search).toBe("?code=foreign&error=foreign");
  });
});
