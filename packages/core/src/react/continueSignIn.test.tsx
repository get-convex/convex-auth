// @vitest-environment jsdom
import { act, renderHook, waitFor } from "@testing-library/react";
import { ReactNode } from "react";
import { afterEach, describe, expect, test, vi } from "vitest";
import { AuthClient } from "../browser/sessionManager.ts";
import { InMemoryStorage } from "../browser/storage.ts";
import type { TokenBundle } from "../lib/types.ts";
import { AuthProvider, useAuth } from "./client.tsx";
import {
  ContinueSignInHookResult,
  useAuthToken,
  useContinueSignIn,
} from "./index.tsx";
import { stubSignInApi } from "./testSignInApi.ts";

// The hook runs its mutation through the injected `AuthSignInApi`, so the test
// substitutes a signInApi rather than mocking `convex/react`.
const { signInApi, run: runMutation } = stubSignInApi();

const NAMESPACE = "https://happy-animal-123.convex.cloud";

const bundle: TokenBundle = {
  accessToken: "access-1",
  accessTokenExpiresAt: 0,
  refreshToken: "refresh-1",
  refreshTokenExpiresAt: 0,
  userId: "user-1",
};

const args = { attemptToken: "attempt-1" };

// The stub signInApi ignores the reference, so any value will do.
const mutation = {} as never;

function renderContinueSignIn() {
  const client = new AuthClient({
    mode: "spa",
    authApi: {
      refreshSession: async () => ({ kind: "noSession" as const }),
      signOut: async () => {},
    },
    storage: new InMemoryStorage(),
    storageNamespace: NAMESPACE,
  });
  const wrapper = ({ children }: { children: ReactNode }) => (
    <AuthProvider authClient={client} signInApi={signInApi}>
      {children}
    </AuthProvider>
  );
  return renderHook(
    () => ({
      auth: useAuth(),
      token: useAuthToken(),
      flow: useContinueSignIn(mutation),
    }),
    { wrapper },
  );
}

describe("useContinueSignIn", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    runMutation.mockReset();
  });

  test("a complete result adopts the session and is returned", async () => {
    runMutation.mockResolvedValue({ status: "complete", tokens: bundle });
    const { result } = renderContinueSignIn();
    await waitFor(() => expect(result.current.auth.isLoading).toBe(false));
    expect(result.current.auth.isAuthenticated).toBe(false);

    let returned!: ContinueSignInHookResult;
    await act(async () => {
      returned = await result.current.flow.continueSignIn(args);
    });

    expect(runMutation).toHaveBeenCalledWith(args);
    expect(returned).toEqual({ status: "complete", tokens: bundle });
    expect(result.current.auth.isAuthenticated).toBe(true);
    expect(result.current.token).toBe("access-1");
  });

  test("an incomplete result passes through without adopting a session", async () => {
    const incomplete = {
      status: "incomplete",
      attemptToken: "attempt-1",
      expiresAt: 3_000,
      requirements: ["totp"],
    };
    runMutation.mockResolvedValue(incomplete);
    const { result } = renderContinueSignIn();
    await waitFor(() => expect(result.current.auth.isLoading).toBe(false));

    let returned!: ContinueSignInHookResult;
    await act(async () => {
      returned = await result.current.flow.continueSignIn(args);
    });

    expect(returned).toEqual(incomplete);
    expect(result.current.auth.isAuthenticated).toBe(false);
  });

  test("a user error is returned without adopting a session", async () => {
    const failure = {
      status: "error",
      userError: { error: "SIGN_IN_EXPIRED" },
    };
    runMutation.mockResolvedValue(failure);
    const { result } = renderContinueSignIn();
    await waitFor(() => expect(result.current.auth.isLoading).toBe(false));

    let returned!: ContinueSignInHookResult;
    await act(async () => {
      returned = await result.current.flow.continueSignIn(args);
    });

    expect(returned).toEqual(failure);
    expect(result.current.auth.isAuthenticated).toBe(false);
  });

  test("a thrown mutation folds into OTHER_ERROR preserving cause", async () => {
    const cause = new Error("network blip");
    runMutation.mockRejectedValue(cause);
    const { result } = renderContinueSignIn();
    await waitFor(() => expect(result.current.auth.isLoading).toBe(false));

    let returned!: ContinueSignInHookResult;
    await act(async () => {
      returned = await result.current.flow.continueSignIn(args);
    });

    expect(returned).toEqual({
      status: "error",
      userError: { error: "OTHER_ERROR", cause },
    });
    expect(result.current.auth.isAuthenticated).toBe(false);
  });

  test("pending is true while in flight and false after, even when the mutation throws", async () => {
    let resolveMutation: (value: unknown) => void;
    runMutation.mockReturnValue(
      new Promise((resolve) => {
        resolveMutation = resolve;
      }),
    );
    const { result } = renderContinueSignIn();
    await waitFor(() => expect(result.current.auth.isLoading).toBe(false));
    expect(result.current.flow.pending).toBe(false);

    let pending: Promise<unknown>;
    act(() => {
      pending = result.current.flow.continueSignIn(args);
    });
    await waitFor(() => expect(result.current.flow.pending).toBe(true));

    await act(async () => {
      resolveMutation!({ status: "complete", tokens: bundle });
      await pending;
    });
    expect(result.current.flow.pending).toBe(false);

    runMutation.mockRejectedValue(new Error("boom"));
    await act(async () => {
      await result.current.flow.continueSignIn(args);
    });
    expect(result.current.flow.pending).toBe(false);
  });
});
