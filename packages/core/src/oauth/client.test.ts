// @vitest-environment jsdom
import { afterEach, describe, expect, test, vi } from "vitest";
import type { AuthSignInApi } from "../browser/ambientSignInClient";
import { AuthClient, type AuthState } from "../browser/sessionManager";
import { InMemoryStorage } from "../browser/storage";
import type { TokenBundle } from "../lib/types";
import { oauth } from "./client";
import {
  ACME_REFS,
  NAMESPACE,
  bundle,
  calledPath,
  flowStorage,
  readFlow,
  restoreNavigatorProduct,
  seedPendingFlow,
  setupOAuth,
  stubReactNative,
} from "./testFlow";

describe("OAuth client", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    window.history.replaceState(null, "", "/");
    restoreNavigatorProduct();
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
          ambientSignIns: { signIns: [oauth(), oauth()], signInApi },
        }),
    ).toThrow(/registered twice/);
  });

  test("init redeems a callback code and adopts the session", async () => {
    window.history.replaceState(null, "", "/?convexAuthCode=code-1");
    const storage = new InMemoryStorage();
    seedPendingFlow(storage);
    const { client, mutation, flowError } = setupOAuth({ storage });
    mutation.mockResolvedValueOnce(bundle);

    await client.init();

    await vi.waitFor(() =>
      expect(client.getSnapshot().isAuthenticated).toBe(true),
    );
    expect(mutation).toHaveBeenCalledOnce();
    // The reference is rebuilt from the persisted function path.
    expect(calledPath(mutation)).toBe("auth:completeSignInAcme");
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
    const { client, mutation } = setupOAuth({ storage });
    mutation.mockResolvedValueOnce(bundle);

    await client.init();

    await vi.waitFor(() =>
      expect(client.getSnapshot().isAuthenticated).toBe(true),
    );
    expect(window.location.search).toBe("");
    expect(window.history.state).toEqual({ idx: 3 });
  });

  test("never reports signed out while a code is redeemed", async () => {
    window.history.replaceState(null, "", "/?convexAuthCode=code-1");
    const storage = new InMemoryStorage();
    seedPendingFlow(storage);
    const { client, mutation } = setupOAuth({ storage });
    const { promise, resolve } = Promise.withResolvers<TokenBundle>();
    mutation.mockReturnValueOnce(promise);

    // The session load finishes long before the redemption does. Any snapshot
    // in between that is done loading and not authenticated would bounce the
    // user to a sign-in screen.
    const signedOut: AuthState[] = [];
    const unsubscribe = client.subscribe(() => {
      const state = client.getSnapshot();
      if (!state.isLoading && !state.isAuthenticated) {
        signedOut.push(state);
      }
    });

    await client.init();
    expect(client.getSnapshot().isLoading).toBe(true);

    resolve(bundle);
    await vi.waitFor(() =>
      expect(client.getSnapshot().isAuthenticated).toBe(true),
    );
    expect(client.getSnapshot().isLoading).toBe(false);
    expect(signedOut).toEqual([]);
    unsubscribe();
  });

  test("a second client on the same URL finds it clean and no-ops", async () => {
    window.history.replaceState(null, "", "/?convexAuthCode=code-1");
    const storage = new InMemoryStorage();
    seedPendingFlow(storage);
    const { client: first, mutation: firstMutation } = setupOAuth({ storage });
    firstMutation.mockResolvedValueOnce(bundle);

    await first.init();
    await vi.waitFor(() =>
      expect(first.getSnapshot().isAuthenticated).toBe(true),
    );
    expect(window.location.search).toBe("");

    // The code is one-time, so a second client over the same page must not try
    // to redeem it again. Each harness makes its own mutation spy, so a second
    // redemption would show up on the second client's spy.
    const {
      client: second,
      mutation: secondMutation,
      flowError: secondFlowError,
    } = setupOAuth({ storage });
    await second.init();

    expect(secondMutation).not.toHaveBeenCalled();
    // A code still in the URL with the flow already consumed would land here
    // as invalid_flow.
    expect(secondFlowError()).toBeNull();
  });

  test("a callback error param sets the flow error and strips the URL", async () => {
    window.history.replaceState(null, "", "/?convexAuthError=access_denied");
    const { client, mutation, flowError } = setupOAuth();

    await client.init();

    expect(flowError()).toEqual({ code: "access_denied" });
    expect(mutation).not.toHaveBeenCalled();
    expect(window.location.search).toBe("");
  });

  test("a callback error consumes the pending flow", async () => {
    window.history.replaceState(null, "", "/?convexAuthError=access_denied");
    const storage = new InMemoryStorage();
    seedPendingFlow(storage);
    const { client, flowError } = setupOAuth({ storage });

    await client.init();

    expect(flowError()?.code).toBe("access_denied");
    // The flow ended in an error, so the stored state can never complete.
    await vi.waitFor(() => expect(readFlow(storage)).toBeNull());
  });

  test("an unknown error param normalizes to oauth_error", async () => {
    window.history.replaceState(null, "", "/?convexAuthError=server_exploded");
    const { client, flowError } = setupOAuth();

    await client.init();

    expect(flowError()?.code).toBe("oauth_error");
  });

  test("a code without a pending flow sets invalid_flow", async () => {
    window.history.replaceState(null, "", "/?convexAuthCode=code-1");
    const { client, mutation, flowError } = setupOAuth();

    await client.init();

    await vi.waitFor(() => expect(flowError()?.code).toBe("invalid_flow"));
    expect(mutation).not.toHaveBeenCalled();
    expect(client.getSnapshot().isLoading).toBe(false);
    expect(client.getSnapshot().isAuthenticated).toBe(false);
  });

  test("a pending flow without a completeSignIn path is invalid", async () => {
    // A record saved by an older client, or tampered with, that has no
    // function path. It must not crash or half-redeem.
    window.history.replaceState(null, "", "/?convexAuthCode=code-1");
    const storage = new InMemoryStorage();
    void flowStorage(storage).set(
      "flow",
      JSON.stringify({ providerName: "acme", state: "state-1" }),
    );
    const { client, mutation, flowError } = setupOAuth({ storage });

    await client.init();

    await vi.waitFor(() => expect(flowError()?.code).toBe("invalid_flow"));
    expect(mutation).not.toHaveBeenCalled();
  });

  test("a null bundle sets expired", async () => {
    window.history.replaceState(null, "", "/?convexAuthCode=code-1");
    const storage = new InMemoryStorage();
    seedPendingFlow(storage);
    const { client, mutation, flowError } = setupOAuth({ storage });
    mutation.mockResolvedValueOnce(null);

    await client.init();

    await vi.waitFor(() => expect(flowError()?.code).toBe("expired"));
    expect(client.getSnapshot().isAuthenticated).toBe(false);
  });

  test("a failed redemption sets oauth_error", async () => {
    // Also the dangling-path case: a persisted function path whose export was
    // renamed mid-flight fails the call the same way.
    window.history.replaceState(null, "", "/?convexAuthCode=code-1");
    const storage = new InMemoryStorage();
    seedPendingFlow(storage);
    const { client, mutation, flowError } = setupOAuth({ storage });
    mutation.mockRejectedValueOnce(new Error("boom"));

    await client.init();

    await vi.waitFor(() => expect(flowError()?.code).toBe("oauth_error"));
    expect(client.getSnapshot().isLoading).toBe(false);
  });

  test("signIn starts a flow, persists it, and returns the redirect", async () => {
    stubReactNative();
    const { mutation, actions, storage } = setupOAuth();
    mutation.mockResolvedValueOnce({
      redirect: "https://provider.example/auth?client_id=x",
      state: "state-1",
    });

    const outcome = await actions.signIn(ACME_REFS, {
      redirectTo: "http://localhost/app",
    });

    expect(mutation).toHaveBeenCalledExactlyOnceWith(ACME_REFS.startSignIn, {
      redirectTo: "http://localhost/app",
    });
    expect(outcome).toEqual({
      redirect: new URL("https://provider.example/auth?client_id=x"),
    });
    // The persisted flow carries the completeSignIn function path, so
    // completion can run on a page that never held the references.
    expect(readFlow(storage)).toEqual({
      providerName: "acme",
      state: "state-1",
      completeSignIn: "auth:completeSignInAcme",
    });
  });

  test("signIn with a code completes the pending flow", async () => {
    const storage = new InMemoryStorage();
    seedPendingFlow(storage);
    const { client, mutation, actions } = setupOAuth({ storage });
    mutation.mockResolvedValueOnce(bundle);

    const outcome = await actions.signIn(ACME_REFS, { code: "code-1" });

    expect(outcome).toEqual({ signedIn: true });
    expect(mutation).toHaveBeenCalledOnce();
    expect(calledPath(mutation)).toBe("auth:completeSignInAcme");
    expect(mutation.mock.calls[0]![1]).toEqual({
      code: "code-1",
      state: "state-1",
    });
    expect(client.getSnapshot().isAuthenticated).toBe(true);
  });

  test("signIn clears a previous flow error", async () => {
    window.history.replaceState(null, "", "/?convexAuthError=access_denied");
    stubReactNative();
    const { client, mutation, actions, flowError } = setupOAuth();
    await client.init();
    expect(flowError()?.code).toBe("access_denied");

    mutation.mockResolvedValueOnce({
      redirect: "https://provider.example/auth",
      state: "state-2",
    });
    // React Native has no page URL to default to, so `redirectTo` is required.
    await actions.signIn(ACME_REFS, { redirectTo: "http://localhost/app" });

    expect(flowError()).toBeNull();
  });

  test("a foreign code/error param is ignored and left in the URL", async () => {
    window.history.replaceState(null, "", "/?code=foreign&error=foreign");
    const { client, mutation, flowError } = setupOAuth();

    await client.init();

    // Only namespaced params are ours. A plain code or error is the app's.
    expect(mutation).not.toHaveBeenCalled();
    expect(flowError()).toBeNull();
    expect(window.location.search).toBe("?code=foreign&error=foreign");
  });
});
