// @vitest-environment jsdom
import { act, renderHook, waitFor } from "@testing-library/react";
import { ReactNode } from "react";
import { afterEach, describe, expect, test, vi } from "vitest";
import { AuthClient } from "../../browser/sessionManager";
import { InMemoryStorage } from "../../browser/storage";
import type { TokenBundle } from "../../lib/types";
import { AuthProvider, useAuth } from "../../react/client";
import { useAuthToken } from "../../react";
import {
  SignInWithPasswordResult,
  SignUpWithPasswordResult,
  useSignInWithPassword,
  useSignUpWithPassword,
} from "./react";

type Result = SignInWithPasswordResult | SignUpWithPasswordResult;
type Flow = {
  run: (c: typeof credentials) => Promise<Result>;
  pending: boolean;
};

const { runAction } = vi.hoisted(() => ({ runAction: vi.fn() }));
vi.mock("convex/react", async (importActual) => ({
  ...(await importActual<typeof import("convex/react")>()),
  useAction: () => runAction,
}));

const NAMESPACE = "https://happy-animal-123.convex.cloud";

const bundle: TokenBundle = {
  accessToken: "access-1",
  accessTokenExpiresAt: 0,
  refreshToken: "refresh-1",
  refreshTokenExpiresAt: 0,
  userId: "user-1",
};

const credentials = { username: "alice", password: "hunter2" };

// The mocked `useAction` ignores the reference, so any value will do.
const action = {} as never;

const flows = [
  {
    name: "useSignInWithPassword",
    useFlow: () => {
      const { signIn, pending } = useSignInWithPassword(action);
      return { run: signIn, pending };
    },
  },
  {
    name: "useSignUpWithPassword",
    useFlow: () => {
      const { signUp, pending } = useSignUpWithPassword(action);
      return { run: signUp, pending };
    },
  },
];

function renderFlow(useFlow: () => Flow) {
  const client = new AuthClient({
    mode: "spa",
    authApi: { refreshSession: async () => null, signOut: async () => {} },
    storage: new InMemoryStorage(),
    storageNamespace: NAMESPACE,
  });
  const wrapper = ({ children }: { children: ReactNode }) => (
    <AuthProvider authClient={client}>{children}</AuthProvider>
  );
  return renderHook(
    () => ({ auth: useAuth(), token: useAuthToken(), flow: useFlow() }),
    { wrapper },
  );
}

describe.each(flows)("$name", ({ useFlow }) => {
  afterEach(() => {
    vi.restoreAllMocks();
    runAction.mockReset();
  });

  test("success adopts the session and returns the result", async () => {
    runAction.mockResolvedValue({ success: true, tokens: bundle });
    const { result } = renderFlow(useFlow);
    await waitFor(() => expect(result.current.auth.isLoading).toBe(false));
    expect(result.current.auth.isAuthenticated).toBe(false);

    let returned!: Result;
    await act(async () => {
      returned = await result.current.flow.run(credentials);
    });

    expect(runAction).toHaveBeenCalledWith(credentials);
    expect(returned).toEqual({ success: true, tokens: bundle });
    expect(result.current.auth.isAuthenticated).toBe(true);
    expect(result.current.token).toBe("access-1");
  });

  test("user error is returned without adopting a session", async () => {
    const failure = { success: false, userError: { error: "USER_NOT_FOUND" } };
    runAction.mockResolvedValue(failure);
    const { result } = renderFlow(useFlow);
    await waitFor(() => expect(result.current.auth.isLoading).toBe(false));

    let returned!: Result;
    await act(async () => {
      returned = await result.current.flow.run(credentials);
    });

    expect(returned).toEqual(failure);
    expect(result.current.auth.isAuthenticated).toBe(false);
  });

  test("thrown action folds into OTHER_ERROR preserving cause", async () => {
    const cause = new Error("network blip");
    runAction.mockRejectedValue(cause);
    const { result } = renderFlow(useFlow);
    await waitFor(() => expect(result.current.auth.isLoading).toBe(false));

    let returned!: Result;
    await act(async () => {
      returned = await result.current.flow.run(credentials);
    });

    expect(returned).toEqual({
      success: false,
      userError: { error: "OTHER_ERROR", cause },
    });
    expect(result.current.auth.isAuthenticated).toBe(false);
  });

  test("pending is true while in flight and false after", async () => {
    let resolveAction: (value: unknown) => void;
    runAction.mockReturnValue(
      new Promise((resolve) => {
        resolveAction = resolve;
      }),
    );
    const { result } = renderFlow(useFlow);
    await waitFor(() => expect(result.current.auth.isLoading).toBe(false));
    expect(result.current.flow.pending).toBe(false);

    let pending: Promise<unknown>;
    act(() => {
      pending = result.current.flow.run(credentials);
    });
    await waitFor(() => expect(result.current.flow.pending).toBe(true));

    await act(async () => {
      resolveAction!({ success: true, tokens: bundle });
      await pending;
    });
    expect(result.current.flow.pending).toBe(false);
  });

  test("pending resets to false when the action throws", async () => {
    runAction.mockRejectedValue(new Error("boom"));
    const { result } = renderFlow(useFlow);
    await waitFor(() => expect(result.current.auth.isLoading).toBe(false));

    await act(async () => {
      await result.current.flow.run(credentials);
    });
    expect(result.current.flow.pending).toBe(false);
  });
});
