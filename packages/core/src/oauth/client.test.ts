// @vitest-environment jsdom
import { afterEach, describe, expect, test, vi } from "vitest";
import { ConvexError } from "convex/values";
import type { AuthState } from "../browser/sessionManager.ts";
import { InMemoryStorage, type TokenStorage } from "../browser/storage.ts";
import {
  completeOauthSignIn,
  handleOauthCallback,
  readOauthCallback,
  startOauthSignIn,
} from "./client.ts";
import {
  acmeRefs,
  calledPath,
  completed,
  flowStorage,
  invalidCode,
  oauthContext,
  readFlow,
  restoreNavigatorProduct,
  seedPendingFlow,
  stubReactNative,
} from "./testFlow.ts";

describe("OAuth client", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    window.history.replaceState(null, "", "/");
    restoreNavigatorProduct();
  });

  test("readOauthCallback returns the code once and removes it", () => {
    window.history.replaceState(null, "", "/page?convexAuthCode=code-1&x=1");

    expect(readOauthCallback()).toEqual({ code: "code-1" });
    expect(window.location.pathname).toBe("/page");
    expect(window.location.search).toBe("?x=1");
    expect(readOauthCallback()).toBeNull();
  });

  test("handleOauthCallback redeems a callback code and adopts the session", async () => {
    window.history.replaceState(null, "", "/?convexAuthCode=code-1");
    const storage = new InMemoryStorage();
    seedPendingFlow(storage);
    const { auth, convex, completeMutation, startMutation, flowError } =
      oauthContext({ storage });
    completeMutation.mockResolvedValueOnce(completed);

    expect(handleOauthCallback({ auth, convex })).toBe(true);
    await auth.init();

    await vi.waitFor(() =>
      expect(auth.getSnapshot().isAuthenticated).toBe(true),
    );
    expect(completeMutation).toHaveBeenCalledOnce();
    // The reference is rebuilt from the stored function path.
    expect(calledPath(completeMutation)).toBe("auth:completeSignInAcme");
    expect(completeMutation.mock.calls[0]![1]).toEqual({
      code: "code-1",
      state: "state-1",
    });
    expect(startMutation).not.toHaveBeenCalled();
    expect(auth.getSnapshot().token).toBe("access-1");
    expect(flowError()).toBeNull();
    // The one-time code is removed from the URL.
    expect(window.location.search).toBe("");
  });

  test("removing the callback params keeps the history state", async () => {
    // Routers (React Router) store their own entry state in `history.state`.
    window.history.replaceState({ idx: 3 }, "", "/?convexAuthCode=code-1");
    const storage = new InMemoryStorage();
    seedPendingFlow(storage);
    const { auth, convex, completeMutation } = oauthContext({ storage });
    completeMutation.mockResolvedValueOnce(completed);

    handleOauthCallback({ auth, convex });

    expect(window.location.search).toBe("");
    expect(window.history.state).toEqual({ idx: 3 });
    await vi.waitFor(() =>
      expect(auth.getSnapshot().isAuthenticated).toBe(true),
    );
  });

  test("never reports signed out while a code is redeemed", async () => {
    window.history.replaceState(null, "", "/?convexAuthCode=code-1");
    const storage = new InMemoryStorage();
    seedPendingFlow(storage);
    const { auth, convex, completeMutation } = oauthContext({ storage });
    const { promise, resolve } = Promise.withResolvers<typeof completed>();
    completeMutation.mockReturnValueOnce(promise);

    // The session load finishes long before the redemption does. Any snapshot
    // in between that is done loading and not authenticated would send the
    // user to a sign-in screen.
    const signedOut: AuthState[] = [];
    const unsubscribe = auth.subscribe(() => {
      const state = auth.getSnapshot();
      if (!state.isLoading && !state.isAuthenticated) {
        signedOut.push(state);
      }
    });

    handleOauthCallback({ auth, convex });
    await auth.init();
    expect(auth.getSnapshot().isLoading).toBe(true);

    resolve(completed);
    await vi.waitFor(() =>
      expect(auth.getSnapshot().isAuthenticated).toBe(true),
    );
    expect(auth.getSnapshot().isLoading).toBe(false);
    expect(signedOut).toEqual([]);
    unsubscribe();
  });

  test("a second client on the same URL finds it clean and does nothing", async () => {
    window.history.replaceState(null, "", "/?convexAuthCode=code-1");
    const storage = new InMemoryStorage();
    seedPendingFlow(storage);
    const first = oauthContext({ storage });
    first.completeMutation.mockResolvedValueOnce(completed);

    expect(handleOauthCallback(first)).toBe(true);
    await vi.waitFor(() =>
      expect(first.auth.getSnapshot().isAuthenticated).toBe(true),
    );

    // The code is one-time, so a second client over the same page must not
    // try to redeem it again. Each harness has its own mocks, so a second
    // redemption would show up on the second client's mock.
    const second = oauthContext({ storage });

    expect(handleOauthCallback(second)).toBe(false);
    expect(second.completeMutation).not.toHaveBeenCalled();
    // A code left in the URL with the flow already consumed would set
    // invalid_flow here.
    expect(second.flowError()).toBeNull();
  });

  test("a callback error param sets the flow error and removes the URL params", () => {
    window.history.replaceState(null, "", "/?convexAuthError=access_denied");
    const { auth, convex, completeMutation, flowError } = oauthContext();

    expect(handleOauthCallback({ auth, convex })).toBe(true);

    expect(flowError()).toEqual({ code: "access_denied" });
    expect(completeMutation).not.toHaveBeenCalled();
    expect(window.location.search).toBe("");
  });

  test("a callback error consumes the pending flow", async () => {
    window.history.replaceState(null, "", "/?convexAuthError=access_denied");
    const storage = new InMemoryStorage();
    seedPendingFlow(storage);
    const { auth, convex, flowError } = oauthContext({ storage });

    handleOauthCallback({ auth, convex });

    expect(flowError()?.code).toBe("access_denied");
    // The flow ended in an error, so the stored state can never complete.
    await vi.waitFor(() => expect(readFlow(storage)).toBeNull());
  });

  test("an unknown error param normalizes to oauth_error", () => {
    window.history.replaceState(null, "", "/?convexAuthError=server_exploded");
    const { auth, convex, flowError } = oauthContext();

    handleOauthCallback({ auth, convex });

    expect(flowError()?.code).toBe("oauth_error");
  });

  test("a code without a pending flow sets invalid_flow", async () => {
    window.history.replaceState(null, "", "/?convexAuthCode=code-1");
    const { auth, convex, completeMutation, flowError } = oauthContext();

    handleOauthCallback({ auth, convex });
    await auth.init();

    await vi.waitFor(() => expect(flowError()?.code).toBe("invalid_flow"));
    expect(completeMutation).not.toHaveBeenCalled();
    expect(auth.getSnapshot().isLoading).toBe(false);
    expect(auth.getSnapshot().isAuthenticated).toBe(false);
  });

  test("a pending flow without a completeSignIn path is invalid", async () => {
    // A record saved by an older client, or edited by hand, that has no
    // function path. It must not crash or partly redeem.
    const storage = new InMemoryStorage();
    void flowStorage(storage).set(
      "flow",
      JSON.stringify({ providerName: "acme", state: "state-1" }),
    );
    const { auth, convex, completeMutation, flowError } = oauthContext({
      storage,
    });

    await expect(completeOauthSignIn({ auth, convex }, "code-1")).resolves.toBe(
      false,
    );

    expect(flowError()?.code).toBe("invalid_flow");
    expect(completeMutation).not.toHaveBeenCalled();
  });

  test("an INVALID_CODE error sets expired", async () => {
    const storage = new InMemoryStorage();
    seedPendingFlow(storage);
    const { auth, convex, completeMutation, flowError } = oauthContext({
      storage,
    });
    completeMutation.mockResolvedValueOnce(invalidCode);

    await expect(completeOauthSignIn({ auth, convex }, "code-1")).resolves.toBe(
      false,
    );

    expect(flowError()?.code).toBe("expired");
    expect(auth.getSnapshot().isAuthenticated).toBe(false);
  });

  test("a thrown redemption sets oauth_error", async () => {
    // Also the case of a stored function path whose export was renamed during
    // the sign-in. The call fails the same way.
    const storage = new InMemoryStorage();
    seedPendingFlow(storage);
    const { auth, convex, completeMutation, flowError } = oauthContext({
      storage,
    });
    completeMutation.mockRejectedValueOnce(new Error("boom"));
    await auth.init();

    await expect(completeOauthSignIn({ auth, convex }, "code-1")).resolves.toBe(
      false,
    );

    expect(flowError()?.code).toBe("oauth_error");
    expect(auth.getSnapshot().isLoading).toBe(false);
  });

  test("an app rejection sets rejected with the ConvexError message", async () => {
    const storage = new InMemoryStorage();
    seedPendingFlow(storage);
    const { auth, convex, completeMutation, flowError } = oauthContext({
      storage,
    });
    completeMutation.mockRejectedValueOnce(
      new ConvexError("A verified email is required to sign in"),
    );

    await completeOauthSignIn({ auth, convex }, "code-1");

    expect(flowError()).toEqual({
      code: "rejected",
      message: "A verified email is required to sign in",
    });
    expect(auth.getSnapshot().isAuthenticated).toBe(false);
  });

  test("an app rejection with non-string data has no message", async () => {
    const storage = new InMemoryStorage();
    seedPendingFlow(storage);
    const { auth, convex, completeMutation, flowError } = oauthContext({
      storage,
    });
    completeMutation.mockRejectedValueOnce(
      new ConvexError({ reason: "policy" }),
    );

    await completeOauthSignIn({ auth, convex }, "code-1");

    expect(flowError()?.code).toBe("rejected");
    // Only a string is text the app meant for the user, so there is nothing
    // to show here.
    expect(flowError()?.message).toBeUndefined();
  });

  test("a rejected storage read during redemption sets oauth_error", async () => {
    window.history.replaceState(null, "", "/?convexAuthCode=code-1");
    // Fail reads of the pending flow key, the way an async storage might.
    // Reads of the session tokens work.
    const storage: TokenStorage = {
      getItem: (key) =>
        key.startsWith("__convexAuthProvider_oauth_flow")
          ? Promise.reject(new Error("storage broken"))
          : null,
      setItem: () => {},
      removeItem: () => {},
    };
    const { auth, convex, completeMutation, flowError } = oauthContext({
      storage,
    });

    handleOauthCallback({ auth, convex });
    await auth.init();

    await vi.waitFor(() => expect(flowError()?.code).toBe("oauth_error"));
    expect(completeMutation).not.toHaveBeenCalled();
    expect(auth.getSnapshot().isLoading).toBe(false);
  });

  test("a rejected storage removal during error cleanup keeps the flow error", async () => {
    window.history.replaceState(null, "", "/?convexAuthError=access_denied");
    const storage: TokenStorage = {
      getItem: () => null,
      setItem: () => {},
      removeItem: () => Promise.reject(new Error("storage broken")),
    };
    const { auth, convex, flowError } = oauthContext({ storage });

    handleOauthCallback({ auth, convex });

    expect(flowError()?.code).toBe("access_denied");
    // The cleanup is not awaited, so let the event loop run once for it to
    // finish. An unhandled rejection from it would fail the test run.
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(flowError()?.code).toBe("access_denied");
  });

  test("startOauthSignIn starts a flow through the Convex client, stores it, and returns the redirect", async () => {
    stubReactNative();
    const { auth, convex, startMutation, completeMutation, storage } =
      oauthContext();
    startMutation.mockResolvedValueOnce({
      redirect: "https://provider.example/auth?client_id=x",
      state: "state-1",
    });

    const outcome = await startOauthSignIn({ auth, convex }, acmeRefs, {
      redirectTo: "http://localhost/app",
    });

    expect(startMutation).toHaveBeenCalledExactlyOnceWith(
      acmeRefs.startSignIn,
      {
        redirectTo: "http://localhost/app",
      },
    );
    expect(completeMutation).not.toHaveBeenCalled();
    expect(outcome).toEqual({
      redirect: new URL("https://provider.example/auth?client_id=x"),
    });
    // The stored flow has the completeSignIn function path, so completion can
    // run on a page that never had the references.
    expect(readFlow(storage)).toEqual({
      providerName: "acme",
      state: "state-1",
      completeSignIn: "auth:completeSignInAcme",
    });
  });

  test("startOauthSignIn with a code completes the pending flow through the auth client", async () => {
    const storage = new InMemoryStorage();
    seedPendingFlow(storage);
    const { auth, convex, completeMutation, startMutation } = oauthContext({
      storage,
    });
    completeMutation.mockResolvedValueOnce(completed);

    const outcome = await startOauthSignIn({ auth, convex }, acmeRefs, {
      code: "code-1",
    });

    expect(outcome).toEqual({ signedIn: true });
    expect(completeMutation).toHaveBeenCalledOnce();
    expect(calledPath(completeMutation)).toBe("auth:completeSignInAcme");
    expect(completeMutation.mock.calls[0]![1]).toEqual({
      code: "code-1",
      state: "state-1",
    });
    expect(startMutation).not.toHaveBeenCalled();
    expect(auth.getSnapshot().isAuthenticated).toBe(true);
  });

  test("startOauthSignIn clears a previous flow error", async () => {
    window.history.replaceState(null, "", "/?convexAuthError=access_denied");
    stubReactNative();
    const { auth, convex, startMutation, flowError } = oauthContext();
    handleOauthCallback({ auth, convex });
    expect(flowError()?.code).toBe("access_denied");

    startMutation.mockResolvedValueOnce({
      redirect: "https://provider.example/auth",
      state: "state-2",
    });
    await startOauthSignIn({ auth, convex }, acmeRefs, {
      redirectTo: "http://localhost/app",
    });

    expect(flowError()).toBeNull();
  });

  test("a failed start sets the flow error and rejects", async () => {
    const { auth, convex, startMutation, flowError, storage } = oauthContext();
    startMutation.mockRejectedValueOnce(new Error("boom"));

    await expect(startOauthSignIn({ auth, convex }, acmeRefs)).rejects.toThrow(
      "boom",
    );

    // The flow error is set even when the caller ignores the rejection, like a
    // click handler that does not await.
    expect(flowError()?.code).toBe("oauth_error");
    expect(flowStorage(storage).get("flow")).toBeNull();
  });

  test("a start that can't store the flow sets the flow error and rejects", async () => {
    const storage: TokenStorage = {
      getItem: () => null,
      setItem: () => Promise.reject(new Error("storage broken")),
      removeItem: () => {},
    };
    const { auth, convex, startMutation, flowError } = oauthContext({
      storage,
    });
    startMutation.mockResolvedValueOnce({
      redirect: "https://provider.example/auth",
      state: "state-1",
    });

    await expect(startOauthSignIn({ auth, convex }, acmeRefs)).rejects.toThrow(
      "storage broken",
    );

    expect(flowError()?.code).toBe("oauth_error");
  });

  test("a rejected start sets the app's message and rejects", async () => {
    const { auth, convex, startMutation, flowError } = oauthContext();
    startMutation.mockRejectedValueOnce(new ConvexError("Sign-ups are closed"));

    await expect(
      startOauthSignIn({ auth, convex }, acmeRefs),
    ).rejects.toThrow();

    expect(flowError()).toEqual({
      code: "rejected",
      message: "Sign-ups are closed",
    });
  });

  test("foreign code and error params are ignored and left in the URL", () => {
    window.history.replaceState(null, "", "/?code=foreign&error=foreign");
    const { auth, convex, completeMutation, flowError } = oauthContext();

    expect(handleOauthCallback({ auth, convex })).toBe(false);

    // Only namespaced params belong to this module. A plain code or error is
    // the app's.
    expect(completeMutation).not.toHaveBeenCalled();
    expect(flowError()).toBeNull();
    expect(window.location.search).toBe("?code=foreign&error=foreign");
  });
});
