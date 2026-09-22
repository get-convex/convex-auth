// @vitest-environment jsdom
import { act, renderHook, waitFor } from "@testing-library/react";
import { ConvexProvider, ConvexReactClient } from "convex/react";
import { ReactNode, StrictMode } from "react";
import { afterEach, describe, expect, test, vi } from "vitest";
import { AuthClient } from "../../browser/sessionManager.ts";
import { InMemoryStorage } from "../../browser/storage.ts";
import type { TokenBundle } from "../../lib/types.ts";
import { AuthProvider, useAuth } from "../../react/client.tsx";
import { stubSignInApi } from "../../react/testSignInApi.ts";
import { useSignInWithEmailPassword } from "./react.tsx";

// The hooks run their mutation through the injected `AuthSignInApi`, so the
// test substitutes a signInApi rather than mocking `convex/react`.
const { signInApi, run: runSignInMutation } = stubSignInApi();

const NAMESPACE = "https://happy-animal-123.convex.cloud";

// The hooks render under a ConvexProvider like in an app. The client never
// connects: no test subscribes to a query.
const convexClient = new ConvexReactClient(NAMESPACE);

const bundle: TokenBundle = {
  accessToken: "access-1",
  accessTokenExpiresAt: 0,
  refreshToken: "refresh-1",
  refreshTokenExpiresAt: 0,
  userId: "user-1",
};

// The stub signInApi ignores the reference, so any value will do.
const signInMutation = {} as never;

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
