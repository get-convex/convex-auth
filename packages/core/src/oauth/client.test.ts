// @vitest-environment jsdom
import { afterEach, describe, expect, test, vi } from "vitest";
import { ConvexError } from "convex/values";
import type { AuthState } from "../browser/sessionManager.ts";
import { InMemoryStorage, type TokenStorage } from "../browser/storage.ts";
import { OAUTH_FLOW_STORAGE_KEY } from "./client.ts";
import {
  acmeRefs,
  calledPath,
  completed,
  flowStorage,
  invalidCode,
  readFlow,
  restoreNavigatorProduct,
  seedPendingFlow,
  setupOAuth,
  stubReactNative,
} from "./testFlow.ts";

describe("OAuth client", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    window.history.replaceState(null, "", "/");
    restoreNavigatorProduct();
  });

  test("starts with no flow error", () => {
    const { flowError } = setupOAuth();
    expect(flowError()).toBeNull();
  });

  test("handleCallback redeems a callback code and adopts the session", async () => {
    window.history.replaceState(null, "", "/?convexAuthCode=code-1");
    const storage = new InMemoryStorage();
    seedPendingFlow(storage);
    const { client, mutation, flowError, start } = setupOAuth({ storage });
    mutation.mockResolvedValueOnce(completed);

    await start();

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
    const { client, mutation, start } = setupOAuth({ storage });
    mutation.mockResolvedValueOnce(completed);

    await start();

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
    const { client, mutation, start } = setupOAuth({ storage });
    const { promise, resolve } = Promise.withResolvers<typeof completed>();
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

    await start();
    expect(client.getSnapshot().isLoading).toBe(true);

    resolve(completed);
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
    const {
      client: first,
      mutation: firstMutation,
      start: startFirst,
    } = setupOAuth({ storage });
    firstMutation.mockResolvedValueOnce(completed);

    await startFirst();
    await vi.waitFor(() =>
      expect(first.getSnapshot().isAuthenticated).toBe(true),
    );
    expect(window.location.search).toBe("");

    // The code is one-time, so a second client over the same page must not try
    // to redeem it again. Each harness makes its own mutation spy, so a second
    // redemption would show up on the second client's spy.
    const {
      mutation: secondMutation,
      flowError: secondFlowError,
      start: startSecond,
    } = setupOAuth({ storage });
    await startSecond();

    expect(secondMutation).not.toHaveBeenCalled();
    // A code still in the URL with the flow already consumed would land here
    // as invalid_flow.
    expect(secondFlowError()).toBeNull();
  });

  test("a callback error param sets the flow error and strips the URL", async () => {
    window.history.replaceState(null, "", "/?convexAuthError=access_denied");
    const { mutation, flowError, start } = setupOAuth();

    await start();

    expect(flowError()).toEqual({ code: "access_denied" });
    expect(mutation).not.toHaveBeenCalled();
    expect(window.location.search).toBe("");
  });

  test("a callback error consumes the pending flow", async () => {
    window.history.replaceState(null, "", "/?convexAuthError=access_denied");
    const storage = new InMemoryStorage();
    seedPendingFlow(storage);
    const { flowError, start } = setupOAuth({ storage });

    await start();

    expect(flowError()?.code).toBe("access_denied");
    // The flow ended in an error, so the stored state can never complete.
    await vi.waitFor(() => expect(readFlow(storage)).toBeNull());
  });

  test("an unknown error param normalizes to oauth_error", async () => {
    window.history.replaceState(null, "", "/?convexAuthError=server_exploded");
    const { flowError, start } = setupOAuth();

    await start();

    expect(flowError()?.code).toBe("oauth_error");
  });

  test("a code without a pending flow sets invalid_flow", async () => {
    window.history.replaceState(null, "", "/?convexAuthCode=code-1");
    const { client, mutation, flowError, start } = setupOAuth();

    await start();

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
      OAUTH_FLOW_STORAGE_KEY,
      JSON.stringify({ providerName: "acme", state: "state-1" }),
    );
    const { mutation, flowError, start } = setupOAuth({ storage });

    await start();

    await vi.waitFor(() => expect(flowError()?.code).toBe("invalid_flow"));
    expect(mutation).not.toHaveBeenCalled();
  });

  test("an INVALID_CODE error sets expired", async () => {
    window.history.replaceState(null, "", "/?convexAuthCode=code-1");
    const storage = new InMemoryStorage();
    seedPendingFlow(storage);
    const { client, mutation, flowError, start } = setupOAuth({ storage });
    mutation.mockResolvedValueOnce(invalidCode);

    await start();

    await vi.waitFor(() => expect(flowError()?.code).toBe("expired"));
    expect(client.getSnapshot().isAuthenticated).toBe(false);
  });

  test("a failed redemption sets oauth_error", async () => {
    // Also the dangling-path case: a persisted function path whose export was
    // renamed mid-flight fails the call the same way.
    window.history.replaceState(null, "", "/?convexAuthCode=code-1");
    const storage = new InMemoryStorage();
    seedPendingFlow(storage);
    const { client, mutation, flowError, start } = setupOAuth({ storage });
    mutation.mockRejectedValueOnce(new Error("boom"));

    await start();

    await vi.waitFor(() => expect(flowError()?.code).toBe("oauth_error"));
    expect(client.getSnapshot().isLoading).toBe(false);
  });

  test("an app rejection sets rejected with the ConvexError message", async () => {
    window.history.replaceState(null, "", "/?convexAuthCode=code-1");
    const storage = new InMemoryStorage();
    seedPendingFlow(storage);
    const { client, mutation, flowError, start } = setupOAuth({ storage });
    mutation.mockRejectedValueOnce(
      new ConvexError("A verified email is required to sign in"),
    );

    await start();

    await vi.waitFor(() =>
      expect(flowError()).toEqual({
        code: "rejected",
        message: "A verified email is required to sign in",
      }),
    );
    expect(client.getSnapshot().isAuthenticated).toBe(false);
  });

  test("an app rejection with non-string data has no message", async () => {
    window.history.replaceState(null, "", "/?convexAuthCode=code-1");
    const storage = new InMemoryStorage();
    seedPendingFlow(storage);
    const { mutation, flowError, start } = setupOAuth({ storage });
    mutation.mockRejectedValueOnce(new ConvexError({ reason: "policy" }));

    await start();

    await vi.waitFor(() => expect(flowError()?.code).toBe("rejected"));
    // Only a string is text the app meant for the user, so there is nothing
    // to show here.
    expect(flowError()?.message).toBeUndefined();
  });

  test("a rejected storage read during redemption sets oauth_error", async () => {
    window.history.replaceState(null, "", "/?convexAuthCode=code-1");
    // Fail reads of the saved flow key, the way an async storage might. Reads
    // of the session tokens still work.
    const storage: TokenStorage = {
      getItem: (key) =>
        key.startsWith(OAUTH_FLOW_STORAGE_KEY)
          ? Promise.reject(new Error("storage broken"))
          : null,
      setItem: () => {},
      removeItem: () => {},
    };
    const { client, mutation, flowError, start } = setupOAuth({ storage });

    await start();

    await vi.waitFor(() => expect(flowError()?.code).toBe("oauth_error"));
    expect(mutation).not.toHaveBeenCalled();
    expect(client.getSnapshot().isLoading).toBe(false);
  });

  test("a rejected storage removal during error cleanup keeps the flow error", async () => {
    window.history.replaceState(null, "", "/?convexAuthError=access_denied");
    const storage: TokenStorage = {
      getItem: () => null,
      setItem: () => {},
      removeItem: () => Promise.reject(new Error("storage broken")),
    };
    const { flowError, start } = setupOAuth({ storage });

    await start();

    expect(flowError()?.code).toBe("access_denied");
    // The cleanup is not awaited, so let the event loop run once for it to
    // finish. An unhandled rejection from it would fail the test run.
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(flowError()?.code).toBe("access_denied");
  });

  test("signIn starts a flow, persists it, and returns the redirect", async () => {
    stubReactNative();
    const { mutation, oauth, storage } = setupOAuth();
    mutation.mockResolvedValueOnce({
      redirect: "https://provider.example/auth?client_id=x",
      state: "state-1",
    });

    const outcome = await oauth.signIn(acmeRefs, {
      redirectTo: "http://localhost/app",
    });

    expect(mutation).toHaveBeenCalledExactlyOnceWith(acmeRefs.startSignIn, {
      redirectTo: "http://localhost/app",
    });
    expect(outcome).toEqual({
      redirect: new URL("https://provider.example/auth?client_id=x"),
    });
    // The persisted flow has the completeSignIn function path, so
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
    const { client, mutation, oauth } = setupOAuth({ storage });
    mutation.mockResolvedValueOnce(completed);

    const outcome = await oauth.signIn(acmeRefs, { code: "code-1" });

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
    const { mutation, oauth, flowError, start } = setupOAuth();
    await start();
    expect(flowError()?.code).toBe("access_denied");

    mutation.mockResolvedValueOnce({
      redirect: "https://provider.example/auth",
      state: "state-2",
    });
    // React Native has no page URL to default to, so `redirectTo` is required.
    await oauth.signIn(acmeRefs, { redirectTo: "http://localhost/app" });

    expect(flowError()).toBeNull();
  });

  test("a failed start sets the flow error and rejects", async () => {
    const { mutation, oauth, flowError, storage } = setupOAuth();
    mutation.mockRejectedValueOnce(new Error("boom"));

    await expect(oauth.signIn(acmeRefs)).rejects.toThrow("boom");

    // The flow error is still published even when the caller ignores the
    // rejection, like a click handler that does not await.
    expect(flowError()?.code).toBe("oauth_error");
    expect(flowStorage(storage).get(OAUTH_FLOW_STORAGE_KEY)).toBeNull();
  });

  test("a start that can't save the flow sets the flow error and rejects", async () => {
    const storage: TokenStorage = {
      getItem: () => null,
      setItem: () => Promise.reject(new Error("storage broken")),
      removeItem: () => {},
    };
    const { mutation, oauth, flowError } = setupOAuth({ storage });
    mutation.mockResolvedValueOnce({
      redirect: "https://provider.example/auth",
      state: "state-1",
    });

    await expect(oauth.signIn(acmeRefs)).rejects.toThrow("storage broken");

    expect(flowError()?.code).toBe("oauth_error");
  });

  test("a rejected start sets the app's message and rejects", async () => {
    const { mutation, oauth, flowError } = setupOAuth();
    mutation.mockRejectedValueOnce(new ConvexError("Sign-ups are closed"));

    await expect(oauth.signIn(acmeRefs)).rejects.toThrow();

    expect(flowError()).toEqual({
      code: "rejected",
      message: "Sign-ups are closed",
    });
  });

  test("a foreign code/error param is ignored and left in the URL", async () => {
    window.history.replaceState(null, "", "/?code=foreign&error=foreign");
    const { mutation, flowError, start } = setupOAuth();

    await start();

    // Only namespaced params are ours. A plain code or error is the app's.
    expect(mutation).not.toHaveBeenCalled();
    expect(flowError()).toBeNull();
    expect(window.location.search).toBe("?code=foreign&error=foreign");
  });

  test("a callback that can't be handled sets oauth_error and the session still loads", async () => {
    // A throw out of handleCallback would keep `init` from running, so
    // anything unexpected there has to become a flow error instead.
    window.history.replaceState(null, "", "/?convexAuthCode=code-1");
    vi.spyOn(window.history, "replaceState").mockImplementation(() => {
      throw new Error("history is unavailable");
    });
    const { client, mutation, flowError, start } = setupOAuth();

    await start();

    expect(flowError()?.code).toBe("oauth_error");
    expect(mutation).not.toHaveBeenCalled();
    expect(client.getSnapshot().isLoading).toBe(false);
  });
});
