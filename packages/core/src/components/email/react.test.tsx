// @vitest-environment jsdom
import { act, renderHook, waitFor } from "@testing-library/react";
import { ConvexProvider, ConvexReactClient } from "convex/react";
import { makeFunctionReference } from "convex/server";
import { ReactNode, StrictMode } from "react";
import { afterEach, describe, expect, test, vi } from "vitest";
import { AuthClient } from "../../browser/sessionManager.ts";
import { InMemoryStorage, NamespacedStorage } from "../../browser/storage.ts";
import type { TokenBundle } from "../../lib/types.ts";
import { AuthProvider, useAuth } from "../../react/client.tsx";
import { stubSignInApi } from "../../react/testSignInApi.ts";
import {
  useCompletePasswordRecovery,
  useCompleteSignUp,
  useSignInWithEmailPassword,
  useSignUpWithEmailPassword,
  useStartPasswordRecovery,
} from "./react.tsx";

// The hooks that mint a session run their mutation through the injected
// `AuthSignInApi`, so the test substitutes a signInApi rather than mocking
// `convex/react`.
const { signInApi, run: runSignInMutation } = stubSignInApi();

const NAMESPACE = "https://happy-animal-123.convex.cloud";

// The hooks read the deployment URL from the surrounding ConvexProvider to
// namespace their secret storage, and the hooks that do not mint a session
// run their mutation through this client. The client never connects: the
// tests stub its `mutation` method and no test subscribes to a query.
const convexClient = new ConvexReactClient(NAMESPACE);
const stubConvexMutation = () => vi.spyOn(convexClient, "mutation");

// The hooks keep flow secrets in `localStorage` (jsdom supplies one),
// namespaced like the hooks namespace it.
const secretStorage = new NamespacedStorage(window.localStorage, NAMESPACE);
const SIGN_UP_SECRET_KEY = "__convexAuthEmailPasswordSignUpSecret";
const RECOVERY_SECRET_KEY = "__convexAuthEmailPasswordRecoverySecret";

const bundle: TokenBundle = {
  accessToken: "access-1",
  accessTokenExpiresAt: 0,
  refreshToken: "refresh-1",
  refreshTokenExpiresAt: 0,
  userId: "user-1",
};

// The stub signInApi ignores the reference, so any value will do.
const signInMutation = {} as never;

// `useMutation` reads the function name of its reference, so the hooks that
// go through the Convex client need a real one. The stubbed client ignores it.
const convexMutation = makeFunctionReference<"mutation">("auth:flow") as never;

function renderWithProviders<T>(useHook: () => T) {
  const authClient = new AuthClient({
    mode: "spa",
    authApi: {
      refreshSession: async () => ({ kind: "noSession" as const }),
      signOut: async () => {},
    },
    storage: new InMemoryStorage(),
    storageNamespace: NAMESPACE,
  });
  // StrictMode runs effects twice in development. The landing page hooks
  // must present a one-shot link once regardless.
  const wrapper = ({ children }: { children: ReactNode }) => (
    <StrictMode>
      <ConvexProvider client={convexClient}>
        <AuthProvider authClient={authClient} signInApi={signInApi}>
          {children}
        </AuthProvider>
      </ConvexProvider>
    </StrictMode>
  );
  return renderHook(() => ({ auth: useAuth(), hook: useHook() }), { wrapper });
}

afterEach(() => {
  vi.restoreAllMocks();
  runSignInMutation.mockReset();
  window.localStorage.clear();
});

describe("useSignInWithEmailPassword", () => {
  const credentials = {
    email: "alice@example.com",
    password: "correct horse battery staple",
  };

  test("adopts the minted session", async () => {
    runSignInMutation.mockResolvedValue({ status: "complete", tokens: bundle });
    const { result } = renderWithProviders(() =>
      useSignInWithEmailPassword(signInMutation),
    );
    await waitFor(() => expect(result.current.auth.isLoading).toBe(false));

    let returned!: Awaited<ReturnType<typeof result.current.hook.signIn>>;
    await act(async () => {
      returned = await result.current.hook.signIn(credentials);
    });

    expect(runSignInMutation).toHaveBeenCalledWith(credentials);
    expect(returned).toEqual({ status: "complete", tokens: bundle });
    expect(result.current.auth.isAuthenticated).toBe(true);
  });

  test("returns a user error without a session", async () => {
    const failure = {
      status: "error",
      userError: { error: "INVALID_CREDENTIALS" },
    };
    runSignInMutation.mockResolvedValue(failure);
    const { result } = renderWithProviders(() =>
      useSignInWithEmailPassword(signInMutation),
    );
    await waitFor(() => expect(result.current.auth.isLoading).toBe(false));

    let returned!: Awaited<ReturnType<typeof result.current.hook.signIn>>;
    await act(async () => {
      returned = await result.current.hook.signIn(credentials);
    });

    expect(returned).toEqual(failure);
    expect(result.current.auth.isAuthenticated).toBe(false);
  });

  test("a thrown mutation folds into OTHER_ERROR preserving cause", async () => {
    const cause = new Error("network blip");
    runSignInMutation.mockRejectedValue(cause);
    const { result } = renderWithProviders(() =>
      useSignInWithEmailPassword(signInMutation),
    );
    await waitFor(() => expect(result.current.auth.isLoading).toBe(false));

    let returned!: Awaited<ReturnType<typeof result.current.hook.signIn>>;
    await act(async () => {
      returned = await result.current.hook.signIn(credentials);
    });

    expect(returned).toEqual({
      status: "error",
      userError: { error: "OTHER_ERROR", cause },
    });
    expect(result.current.hook.pending).toBe(false);
  });

  test("stays pending until the last overlapping call ends", async () => {
    const failure = {
      status: "error",
      userError: { error: "INVALID_CREDENTIALS" },
    };
    const resolvers: Array<(value: unknown) => void> = [];
    runSignInMutation.mockImplementation(
      () => new Promise((resolve) => resolvers.push(resolve)),
    );
    const { result } = renderWithProviders(() =>
      useSignInWithEmailPassword(signInMutation),
    );
    await waitFor(() => expect(result.current.auth.isLoading).toBe(false));

    let first!: Promise<unknown>;
    let second!: Promise<unknown>;
    act(() => {
      first = result.current.hook.signIn(credentials);
      second = result.current.hook.signIn(credentials);
    });
    expect(result.current.hook.pending).toBe(true);

    await act(async () => {
      resolvers[0](failure);
      await first;
    });
    expect(result.current.hook.pending).toBe(true);

    await act(async () => {
      resolvers[1](failure);
      await second;
    });
    expect(result.current.hook.pending).toBe(false);
  });
});

describe("useSignUpWithEmailPassword", () => {
  const credentials = {
    email: "alice@example.com",
    password: "correct horse battery staple",
  };

  test("success stores the secret and does not sign in", async () => {
    runSignInMutation.mockResolvedValue({
      success: true,
      browserSecret: "secret-1",
    });
    const { result } = renderWithProviders(() =>
      useSignUpWithEmailPassword(signInMutation),
    );
    await waitFor(() => expect(result.current.auth.isLoading).toBe(false));

    let returned!: Awaited<ReturnType<typeof result.current.hook.signUp>>;
    await act(async () => {
      returned = await result.current.hook.signUp(credentials);
    });

    expect(returned).toEqual({ success: true, browserSecret: "secret-1" });
    // The secret is kept for the completion step; no session was adopted.
    expect(secretStorage.get(SIGN_UP_SECRET_KEY)).toBe("secret-1");
    expect(result.current.auth.isAuthenticated).toBe(false);
  });

  test("a user error stores nothing", async () => {
    const failure = { success: false, userError: { error: "EMAIL_TAKEN" } };
    runSignInMutation.mockResolvedValue(failure);
    const { result } = renderWithProviders(() =>
      useSignUpWithEmailPassword(signInMutation),
    );
    await waitFor(() => expect(result.current.auth.isLoading).toBe(false));

    let returned!: Awaited<ReturnType<typeof result.current.hook.signUp>>;
    await act(async () => {
      returned = await result.current.hook.signUp(credentials);
    });

    expect(returned).toEqual(failure);
    expect(secretStorage.get(SIGN_UP_SECRET_KEY)).toBeNull();
  });

  test("a thrown mutation folds into OTHER_ERROR preserving cause", async () => {
    const cause = new Error("network blip");
    runSignInMutation.mockRejectedValue(cause);
    const { result } = renderWithProviders(() =>
      useSignUpWithEmailPassword(signInMutation),
    );
    await waitFor(() => expect(result.current.auth.isLoading).toBe(false));

    let returned!: Awaited<ReturnType<typeof result.current.hook.signUp>>;
    await act(async () => {
      returned = await result.current.hook.signUp(credentials);
    });

    expect(returned).toEqual({
      success: false,
      userError: { error: "OTHER_ERROR", cause },
    });
    expect(result.current.hook.pending).toBe(false);
  });
});

describe("useCompleteSignUp", () => {
  test("presents the link once as the page opens, adopts the session, clears the secret", async () => {
    secretStorage.set(SIGN_UP_SECRET_KEY, "secret-1");
    runSignInMutation.mockResolvedValue({ status: "complete", tokens: bundle });
    const { result } = renderWithProviders(() =>
      useCompleteSignUp(signInMutation, { emailCode: "code-1" }),
    );
    await waitFor(() =>
      expect(result.current.hook).toEqual({ status: "complete" }),
    );

    // The mutation received the code from the link plus the stored secret.
    expect(runSignInMutation).toHaveBeenCalledTimes(1);
    expect(runSignInMutation).toHaveBeenCalledWith({
      emailCode: "code-1",
      browserSecret: "secret-1",
    });
    expect(result.current.auth.isAuthenticated).toBe(true);
    // The secret is cleared once it has served its purpose.
    expect(secretStorage.get(SIGN_UP_SECRET_KEY)).toBeNull();
  });

  test("presents the link once when the effect runs again", async () => {
    secretStorage.set(SIGN_UP_SECRET_KEY, "secret-1");
    // Keep the mutation in flight, so the secret is still stored when the
    // effect runs again.
    let resolveMutation!: (value: unknown) => void;
    runSignInMutation.mockReturnValue(
      new Promise((resolve) => {
        resolveMutation = resolve;
      }),
    );
    let emailCode = "code-1";
    const { result, rerender } = renderWithProviders(() =>
      useCompleteSignUp(signInMutation, { emailCode }),
    );
    await waitFor(() => expect(runSignInMutation).toHaveBeenCalledTimes(1));

    // A new code changes the effect's dependencies, so the effect runs again.
    emailCode = "code-2";
    rerender();
    await act(async () => {
      resolveMutation({ status: "complete", tokens: bundle });
    });
    await waitFor(() =>
      expect(result.current.hook).toEqual({ status: "complete" }),
    );

    expect(runSignInMutation).toHaveBeenCalledTimes(1);
    expect(runSignInMutation).toHaveBeenCalledWith({
      emailCode: "code-1",
      browserSecret: "secret-1",
    });
  });

  test("reports isLoading while the link is validated", async () => {
    secretStorage.set(SIGN_UP_SECRET_KEY, "secret-1");
    let resolveMutation!: (value: unknown) => void;
    runSignInMutation.mockReturnValue(
      new Promise((resolve) => {
        resolveMutation = resolve;
      }),
    );
    const { result } = renderWithProviders(() =>
      useCompleteSignUp(signInMutation, { emailCode: "code-1" }),
    );
    await waitFor(() => expect(runSignInMutation).toHaveBeenCalledTimes(1));

    // The app does not see a signed-out user while the mutation runs.
    expect(result.current.auth).toMatchObject({
      isLoading: true,
      isAuthenticated: false,
    });

    await act(async () => {
      resolveMutation({ status: "complete", tokens: bundle });
    });
    await waitFor(() =>
      expect(result.current.hook).toEqual({ status: "complete" }),
    );
    expect(result.current.auth).toMatchObject({
      isLoading: false,
      isAuthenticated: true,
    });
  });

  test("is MISSING_SECRET when this browser did not start the flow", async () => {
    const { result } = renderWithProviders(() =>
      useCompleteSignUp(signInMutation, { emailCode: "code-1" }),
    );
    await waitFor(() =>
      expect(result.current.hook).toEqual({
        status: "error",
        userError: { error: "MISSING_SECRET" },
      }),
    );

    // The backend was never called: there was nothing to present.
    expect(runSignInMutation).not.toHaveBeenCalled();
    expect(result.current.auth.isAuthenticated).toBe(false);
  });

  test("keeps the secret when the completion fails", async () => {
    secretStorage.set(SIGN_UP_SECRET_KEY, "secret-1");
    runSignInMutation.mockResolvedValue({
      status: "error",
      userError: { error: "INVALID_CHALLENGE" },
    });
    const { result } = renderWithProviders(() =>
      useCompleteSignUp(signInMutation, { emailCode: "code-1" }),
    );
    await waitFor(() =>
      expect(result.current.hook).toEqual({
        status: "error",
        userError: { error: "INVALID_CHALLENGE" },
      }),
    );

    expect(secretStorage.get(SIGN_UP_SECRET_KEY)).toBe("secret-1");
    expect(result.current.auth.isAuthenticated).toBe(false);
  });

  test("a thrown mutation becomes an OTHER_ERROR state preserving cause", async () => {
    secretStorage.set(SIGN_UP_SECRET_KEY, "secret-1");
    const cause = new Error("network blip");
    runSignInMutation.mockRejectedValue(cause);
    const { result } = renderWithProviders(() =>
      useCompleteSignUp(signInMutation, { emailCode: "code-1" }),
    );
    await waitFor(() =>
      expect(result.current.hook).toEqual({
        status: "error",
        userError: { error: "OTHER_ERROR", cause },
      }),
    );
  });
});

describe("useStartPasswordRecovery", () => {
  test("success stores the secret", async () => {
    const mutation = stubConvexMutation().mockResolvedValue({
      success: true,
      browserSecret: "secret-9",
    });
    const { result } = renderWithProviders(() =>
      useStartPasswordRecovery(convexMutation),
    );

    let returned!: Awaited<
      ReturnType<typeof result.current.hook.startPasswordRecovery>
    >;
    await act(async () => {
      returned = await result.current.hook.startPasswordRecovery({
        email: "alice@example.com",
      });
    });

    expect(mutation.mock.calls[0]?.[1]).toEqual({ email: "alice@example.com" });
    expect(returned).toEqual({ success: true, browserSecret: "secret-9" });
    expect(secretStorage.get(RECOVERY_SECRET_KEY)).toBe("secret-9");
  });

  test("a thrown mutation folds into OTHER_ERROR preserving cause", async () => {
    const cause = new Error("network blip");
    stubConvexMutation().mockRejectedValue(cause);
    const { result } = renderWithProviders(() =>
      useStartPasswordRecovery(convexMutation),
    );

    let returned!: Awaited<
      ReturnType<typeof result.current.hook.startPasswordRecovery>
    >;
    await act(async () => {
      returned = await result.current.hook.startPasswordRecovery({
        email: "alice@example.com",
      });
    });

    expect(returned).toEqual({
      success: false,
      userError: { error: "OTHER_ERROR", cause },
    });
    expect(secretStorage.get(RECOVERY_SECRET_KEY)).toBeNull();
  });
});

describe("useCompletePasswordRecovery", () => {
  test("is ready with the stored secret; completing adopts the session and clears it", async () => {
    secretStorage.set(RECOVERY_SECRET_KEY, "secret-9");
    runSignInMutation.mockResolvedValue({ status: "complete", tokens: bundle });
    const { result } = renderWithProviders(() =>
      useCompletePasswordRecovery(signInMutation, { emailCode: "code-9" }),
    );
    await waitFor(() => expect(result.current.hook.status).toBe("ready"));
    const ready = result.current.hook;
    if (ready.status !== "ready") throw new Error("unreachable");

    let returned!: Awaited<ReturnType<typeof ready.completePasswordRecovery>>;
    await act(async () => {
      returned = await ready.completePasswordRecovery({
        newPassword: "brand new horse staple",
      });
    });

    expect(runSignInMutation).toHaveBeenCalledWith({
      emailCode: "code-9",
      browserSecret: "secret-9",
      newPassword: "brand new horse staple",
    });
    expect(returned).toEqual({ status: "complete", tokens: bundle });
    expect(result.current.hook).toEqual({ status: "complete" });
    expect(result.current.auth.isAuthenticated).toBe(true);
    expect(secretStorage.get(RECOVERY_SECRET_KEY)).toBeNull();
  });

  test("is MISSING_SECRET when this browser did not start the flow", async () => {
    const { result } = renderWithProviders(() =>
      useCompletePasswordRecovery(signInMutation, { emailCode: "code-9" }),
    );
    await waitFor(() =>
      expect(result.current.hook).toEqual({
        status: "error",
        userError: { error: "MISSING_SECRET" },
      }),
    );
    expect(runSignInMutation).not.toHaveBeenCalled();
  });

  test("a rejected password leaves the flow ready for another try", async () => {
    secretStorage.set(RECOVERY_SECRET_KEY, "secret-9");
    const failure = {
      status: "error",
      userError: { error: "PASSWORD_TOO_SHORT", minimumLength: 8 },
    };
    runSignInMutation.mockResolvedValue(failure);
    const { result } = renderWithProviders(() =>
      useCompletePasswordRecovery(signInMutation, { emailCode: "code-9" }),
    );
    await waitFor(() => expect(result.current.hook.status).toBe("ready"));
    const ready = result.current.hook;
    if (ready.status !== "ready") throw new Error("unreachable");

    let returned!: Awaited<ReturnType<typeof ready.completePasswordRecovery>>;
    await act(async () => {
      returned = await ready.completePasswordRecovery({ newPassword: "short" });
    });

    expect(returned).toEqual(failure);
    expect(result.current.hook.status).toBe("ready");
    // The link was not consumed: the secret must still work.
    expect(secretStorage.get(RECOVERY_SECRET_KEY)).toBe("secret-9");
    expect(result.current.auth.isAuthenticated).toBe(false);
  });

  test("an unusable link ends the flow", async () => {
    secretStorage.set(RECOVERY_SECRET_KEY, "secret-9");
    runSignInMutation.mockResolvedValue({
      status: "error",
      userError: { error: "INVALID_CHALLENGE" },
    });
    const { result } = renderWithProviders(() =>
      useCompletePasswordRecovery(signInMutation, { emailCode: "code-9" }),
    );
    await waitFor(() => expect(result.current.hook.status).toBe("ready"));
    const ready = result.current.hook;
    if (ready.status !== "ready") throw new Error("unreachable");

    await act(async () => {
      await ready.completePasswordRecovery({ newPassword: "brand new horse" });
    });

    expect(result.current.hook).toEqual({
      status: "error",
      userError: { error: "INVALID_CHALLENGE" },
    });
  });
});
