// @vitest-environment jsdom
import { act, renderHook, waitFor } from "@testing-library/react";
import { ConvexProvider, ConvexReactClient } from "convex/react";
import { ReactNode } from "react";
import { afterEach, describe, expect, test, vi } from "vitest";
import { AuthClient } from "../../browser/sessionManager.ts";
import { InMemoryStorage, NamespacedStorage } from "../../browser/storage.ts";
import type { TokenBundle } from "../../lib/types.ts";
import { AuthProvider, useAuth } from "../../react/client.tsx";
import { stubSignInApi } from "../../react/testSignInApi.ts";
import {
  useCompleteRecovery,
  useCompleteSignUp,
  useSignUpWithEmailPassword,
} from "./react.tsx";

// The hooks run their mutation through the injected `AuthSignInApi`, so the
// test substitutes a signInApi rather than mocking `convex/react`.
const { signInApi, run: runMutation } = stubSignInApi();

const NAMESPACE = "https://happy-animal-123.convex.cloud";

// The hooks read the deployment URL from the surrounding ConvexProvider to
// namespace their secret storage. The client never connects: no test
// subscribes to a query.
const convexClient = new ConvexReactClient(NAMESPACE);

// The hooks keep flow secrets in `localStorage` (jsdom supplies one),
// namespaced like the hooks namespace it.
const secretStorage = new NamespacedStorage(window.localStorage, NAMESPACE);

const bundle: TokenBundle = {
  accessToken: "access-1",
  accessTokenExpiresAt: 0,
  refreshToken: "refresh-1",
  refreshTokenExpiresAt: 0,
  userId: "user-1",
};

// The stub signInApi ignores the reference, so any value will do.
const mutation = {} as never;

function renderWithProviders<T>(useHook: () => T) {
  const authClient = new AuthClient({
    mode: "spa",
    authApi: { refreshSession: async () => null, signOut: async () => {} },
    storage: new InMemoryStorage(),
    storageNamespace: NAMESPACE,
  });
  const wrapper = ({ children }: { children: ReactNode }) => (
    <ConvexProvider client={convexClient}>
      <AuthProvider authClient={authClient} signInApi={signInApi}>
        {children}
      </AuthProvider>
    </ConvexProvider>
  );
  return renderHook(() => ({ auth: useAuth(), hook: useHook() }), { wrapper });
}

afterEach(() => {
  vi.restoreAllMocks();
  runMutation.mockReset();
  window.localStorage.clear();
});

describe("useSignUpWithEmailPassword", () => {
  test("success stores the secret and does not sign in", async () => {
    runMutation.mockResolvedValue({
      success: true,
      secret: "secret-1",
      userId: "user-1",
    });
    const { result } = renderWithProviders(() =>
      useSignUpWithEmailPassword(mutation),
    );
    await waitFor(() => expect(result.current.auth.isLoading).toBe(false));

    let returned!: Awaited<ReturnType<typeof result.current.hook.signUp>>;
    await act(async () => {
      returned = await result.current.hook.signUp({
        email: "alice@example.com",
        password: "correct horse battery staple",
      });
    });

    expect(returned).toEqual({
      success: true,
      secret: "secret-1",
      userId: "user-1",
    });
    // The secret and the user are kept for the completion step; no session
    // was adopted.
    expect(secretStorage.get("__convexAuthEmailPasswordSignUpSecret")).toBe(
      "secret-1",
    );
    expect(secretStorage.get("__convexAuthEmailPasswordSignUpUserId")).toBe(
      "user-1",
    );
    expect(result.current.auth.isAuthenticated).toBe(false);
  });

  test("a user error stores nothing", async () => {
    const failure = { success: false, userError: { error: "EMAIL_TAKEN" } };
    runMutation.mockResolvedValue(failure);
    const { result } = renderWithProviders(() =>
      useSignUpWithEmailPassword(mutation),
    );
    await waitFor(() => expect(result.current.auth.isLoading).toBe(false));

    let returned!: Awaited<ReturnType<typeof result.current.hook.signUp>>;
    await act(async () => {
      returned = await result.current.hook.signUp({
        email: "alice@example.com",
        password: "correct horse battery staple",
      });
    });

    expect(returned).toEqual(failure);
    expect(
      secretStorage.get("__convexAuthEmailPasswordSignUpSecret"),
    ).toBeNull();
  });

  test("a thrown mutation folds into OTHER_ERROR preserving cause", async () => {
    const cause = new Error("network blip");
    runMutation.mockRejectedValue(cause);
    const { result } = renderWithProviders(() =>
      useSignUpWithEmailPassword(mutation),
    );
    await waitFor(() => expect(result.current.auth.isLoading).toBe(false));

    let returned!: Awaited<ReturnType<typeof result.current.hook.signUp>>;
    await act(async () => {
      returned = await result.current.hook.signUp({
        email: "alice@example.com",
        password: "correct horse battery staple",
      });
    });

    expect(returned).toEqual({
      success: false,
      userError: { error: "OTHER_ERROR", cause },
    });
    expect(result.current.hook.pending).toBe(false);
  });
});

describe("useCompleteSignUp", () => {
  test("consumes the stored secret and adopts the session", async () => {
    secretStorage.set("__convexAuthEmailPasswordSignUpSecret", "secret-1");
    secretStorage.set("__convexAuthEmailPasswordSignUpUserId", "user-1");
    runMutation.mockResolvedValue({ success: true, tokens: bundle });
    const { result } = renderWithProviders(() => useCompleteSignUp(mutation));
    await waitFor(() => expect(result.current.auth.isLoading).toBe(false));

    let returned!: Awaited<
      ReturnType<typeof result.current.hook.completeSignUp>
    >;
    await act(async () => {
      returned = await result.current.hook.completeSignUp({ code: "code-1" });
    });

    // The mutation received the code from the link plus the stored secret
    // and user.
    expect(runMutation).toHaveBeenCalledWith({
      code: "code-1",
      secret: "secret-1",
      userId: "user-1",
    });
    expect(returned).toEqual({ success: true, tokens: bundle });
    expect(result.current.auth.isAuthenticated).toBe(true);
    // The secret and the user are cleared once they have served their
    // purpose.
    expect(
      secretStorage.get("__convexAuthEmailPasswordSignUpSecret"),
    ).toBeNull();
    expect(
      secretStorage.get("__convexAuthEmailPasswordSignUpUserId"),
    ).toBeNull();
  });

  test("returns MISSING_SECRET when this browser did not start the flow", async () => {
    const { result } = renderWithProviders(() => useCompleteSignUp(mutation));
    await waitFor(() => expect(result.current.auth.isLoading).toBe(false));

    let returned!: Awaited<
      ReturnType<typeof result.current.hook.completeSignUp>
    >;
    await act(async () => {
      returned = await result.current.hook.completeSignUp({ code: "code-1" });
    });

    expect(returned).toEqual({
      success: false,
      userError: { error: "MISSING_SECRET" },
    });
    // The backend was never called: there was nothing to present.
    expect(runMutation).not.toHaveBeenCalled();
    expect(result.current.auth.isAuthenticated).toBe(false);
  });

  test("returns MISSING_SECRET when the user is missing from storage", async () => {
    secretStorage.set("__convexAuthEmailPasswordSignUpSecret", "secret-1");
    const { result } = renderWithProviders(() => useCompleteSignUp(mutation));
    await waitFor(() => expect(result.current.auth.isLoading).toBe(false));

    let returned!: Awaited<
      ReturnType<typeof result.current.hook.completeSignUp>
    >;
    await act(async () => {
      returned = await result.current.hook.completeSignUp({ code: "code-1" });
    });

    expect(returned).toEqual({
      success: false,
      userError: { error: "MISSING_SECRET" },
    });
    expect(runMutation).not.toHaveBeenCalled();
  });

  test("keeps the secret when completion fails", async () => {
    secretStorage.set("__convexAuthEmailPasswordSignUpSecret", "secret-1");
    secretStorage.set("__convexAuthEmailPasswordSignUpUserId", "user-1");
    runMutation.mockResolvedValue({
      success: false,
      userError: { error: "INVALID_LINK" },
    });
    const { result } = renderWithProviders(() => useCompleteSignUp(mutation));
    await waitFor(() => expect(result.current.auth.isLoading).toBe(false));

    await act(async () => {
      await result.current.hook.completeSignUp({ code: "code-1" });
    });

    expect(secretStorage.get("__convexAuthEmailPasswordSignUpSecret")).toBe(
      "secret-1",
    );
    expect(result.current.auth.isAuthenticated).toBe(false);
  });
});

describe("useCompleteRecovery", () => {
  test("consumes the stored secret, sends the new password, adopts the session", async () => {
    secretStorage.set("__convexAuthEmailPasswordRecoverySecret", "secret-9");
    runMutation.mockResolvedValue({ success: true, tokens: bundle });
    const { result } = renderWithProviders(() => useCompleteRecovery(mutation));
    await waitFor(() => expect(result.current.auth.isLoading).toBe(false));

    let returned!: Awaited<
      ReturnType<typeof result.current.hook.completeRecovery>
    >;
    await act(async () => {
      returned = await result.current.hook.completeRecovery({
        code: "code-9",
        newPassword: "brand new horse staple",
      });
    });

    expect(runMutation).toHaveBeenCalledWith({
      code: "code-9",
      secret: "secret-9",
      newPassword: "brand new horse staple",
    });
    expect(returned).toEqual({ success: true, tokens: bundle });
    expect(result.current.auth.isAuthenticated).toBe(true);
    expect(
      secretStorage.get("__convexAuthEmailPasswordRecoverySecret"),
    ).toBeNull();
  });

  test("returns MISSING_SECRET when this browser did not start the flow", async () => {
    const { result } = renderWithProviders(() => useCompleteRecovery(mutation));
    await waitFor(() => expect(result.current.auth.isLoading).toBe(false));

    let returned!: Awaited<
      ReturnType<typeof result.current.hook.completeRecovery>
    >;
    await act(async () => {
      returned = await result.current.hook.completeRecovery({
        code: "code-9",
        newPassword: "brand new horse staple",
      });
    });

    expect(returned).toEqual({
      success: false,
      userError: { error: "MISSING_SECRET" },
    });
    expect(runMutation).not.toHaveBeenCalled();
  });
});
