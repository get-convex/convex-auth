// @vitest-environment jsdom
import { act, renderHook, waitFor } from "@testing-library/react";
import { ReactNode } from "react";
import { afterEach, describe, expect, expectTypeOf, test, vi } from "vitest";
import { AuthClient } from "../browser/sessionManager.ts";
import { InMemoryStorage } from "../browser/storage.ts";
import type { AttemptToken, TokenBundle } from "../lib/types.ts";
import { AuthProvider, useAuth, usePendingSignInContext } from "./client.tsx";
import {
  ContinueSignInHookResult,
  useAuthToken,
  useContinueSignIn,
  usePendingSignIn,
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

const held = {
  status: "incomplete" as const,
  attemptToken: "attempt-1",
  expiresAt: 3_000,
  requirements: ["totp"],
};

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
      pending: usePendingSignIn(),
      // Stands in for the provider hook that held the sign-in.
      adopt: usePendingSignInContext().adopt,
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

  test("a complete result adopts the session, clears the pending sign-in, and is returned", async () => {
    runMutation.mockResolvedValue({ status: "complete", tokens: bundle });
    const { result } = renderContinueSignIn();
    await waitFor(() => expect(result.current.auth.isLoading).toBe(false));
    expect(result.current.auth.isAuthenticated).toBe(false);
    await act(() => result.current.adopt(held));
    expect(result.current.pending.pendingSignIn).toEqual(held);

    let returned!: ContinueSignInHookResult;
    await act(async () => {
      returned = await result.current.flow.continueSignIn(args);
    });

    expect(runMutation).toHaveBeenCalledWith(args);
    expect(returned).toEqual({ status: "complete", tokens: bundle });
    expect(result.current.auth.isAuthenticated).toBe(true);
    expect(result.current.token).toBe("access-1");
    expect(result.current.pending.pendingSignIn).toBeNull();
  });

  test("an incomplete result passes through and is held, without adopting a session", async () => {
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
    expect(result.current.pending.pendingSignIn).toEqual(incomplete);
    expect(result.current.auth.isAuthenticated).toBe(false);
  });

  test("the result names only the requirements the attempt token carries", async () => {
    runMutation.mockResolvedValue({
      status: "incomplete",
      attemptToken: "attempt-1",
      expiresAt: 3_000,
      requirements: ["totp"],
    });
    const { result } = renderContinueSignIn();
    await waitFor(() => expect(result.current.auth.isLoading).toBe(false));

    // A provider result types its token by what it can hold a sign-in for.
    const attemptToken = "attempt-1" as AttemptToken<"totp" | "terms">;
    const returned = await act(() =>
      result.current.flow.continueSignIn({ attemptToken }),
    );

    expectTypeOf(returned).toEqualTypeOf<
      ContinueSignInHookResult<"totp" | "terms">
    >();
    if (returned.status !== "incomplete") throw new Error("not incomplete");
    expectTypeOf(returned.requirements).toEqualTypeOf<("totp" | "terms")[]>();
    expect(returned.requirements).toEqual(["totp"]);
  });

  test("an expired attempt is returned and marks the pending sign-in expired", async () => {
    const failure = {
      status: "error",
      userError: { error: "SIGN_IN_EXPIRED" },
    };
    runMutation.mockResolvedValue(failure);
    const { result } = renderContinueSignIn();
    await waitFor(() => expect(result.current.auth.isLoading).toBe(false));
    await act(() => result.current.adopt(held));

    let returned!: ContinueSignInHookResult;
    await act(async () => {
      returned = await result.current.flow.continueSignIn(args);
    });

    expect(returned).toEqual(failure);
    expect(result.current.auth.isAuthenticated).toBe(false);
    expect(result.current.pending.pendingSignIn).toBeNull();
    expect(result.current.pending.expired).toBe(true);

    // The next sign-in result replaces the expired one.
    await act(() => result.current.adopt(held));
    expect(result.current.pending.pendingSignIn).toEqual(held);
    expect(result.current.pending.expired).toBe(false);
  });

  test("cancel drops the pending sign-in and the expired flag", async () => {
    const { result } = renderContinueSignIn();
    await waitFor(() => expect(result.current.auth.isLoading).toBe(false));
    await act(() => result.current.adopt(held));

    act(() => result.current.pending.cancel());
    expect(result.current.pending.pendingSignIn).toBeNull();
    expect(result.current.pending.expired).toBe(false);

    await act(() =>
      result.current.adopt({
        status: "error",
        userError: { error: "SIGN_IN_EXPIRED" },
      }),
    );
    act(() => result.current.pending.cancel());
    expect(result.current.pending.expired).toBe(false);
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

  test("usePendingSignIn outside a provider throws", () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    expect(() => renderHook(() => usePendingSignIn())).toThrow(
      /usePendingSignIn must be used within/,
    );
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
