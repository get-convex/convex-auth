// @vitest-environment jsdom
import { act, renderHook, waitFor } from "@testing-library/react";
import { ReactNode } from "react";
import { afterEach, describe, expect, test, vi } from "vitest";
import { AuthClient } from "../browser/sessionManager";
import { InMemoryStorage } from "../browser/storage";
import type { SlimTokenBundle } from "../lib/types";
import { useAuthToken } from "../react";
import { AuthProvider, useAuth } from "../react/client";
import {
  SignInWithPasswordResult,
  SignUpWithPasswordResult,
  useSignInWithPassword,
  useSignUpWithPassword,
} from "./index";

type Result = SignInWithPasswordResult | SignUpWithPasswordResult;
type Flow = {
  run: (c: typeof credentials) => Promise<Result>;
  pending: boolean;
};

const fetchMock = vi.fn();
vi.stubGlobal("fetch", fetchMock);

const NAMESPACE = "https://happy-animal-123.convex.cloud";

const slimBundle: SlimTokenBundle = {
  accessToken: "access-1",
  accessTokenExpiresAt: 0,
  userId: "user-1",
};

const credentials = { username: "alice", password: "hunter2" };

const flows = [
  {
    name: "useSignInWithPassword",
    route: "/auth/signin/password",
    useFlow: () => {
      const { signIn, pending } = useSignInWithPassword();
      return { run: signIn, pending };
    },
  },
  {
    name: "useSignUpWithPassword",
    route: "/auth/signup/password",
    useFlow: () => {
      const { signUp, pending } = useSignUpWithPassword();
      return { run: signUp, pending };
    },
  },
];

function renderFlow(useFlow: () => Flow) {
  const client = new AuthClient({
    mode: "ssr",
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

describe.each(flows)("$name", ({ route, useFlow }) => {
  afterEach(() => {
    fetchMock.mockReset();
  });

  test("success POSTs the credentials, adopts the session, and returns success", async () => {
    fetchMock.mockResolvedValue(Response.json({ tokens: slimBundle }));
    const { result } = renderFlow(useFlow);
    await waitFor(() => expect(result.current.auth.isLoading).toBe(false));
    expect(result.current.auth.isAuthenticated).toBe(false);

    let returned!: Result;
    await act(async () => {
      returned = await result.current.flow.run(credentials);
    });

    expect(fetchMock).toHaveBeenCalledWith(route, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(credentials),
    });
    expect(returned).toEqual({ success: true });
    expect(result.current.auth.isAuthenticated).toBe(true);
    expect(result.current.token).toBe("access-1");
  });

  test("the route's userError is returned without adopting a session", async () => {
    const userError = { error: "USER_NOT_FOUND" };
    // Failed sign-ins reply 401 with the userError in the body.
    fetchMock.mockResolvedValue(
      Response.json({ tokens: null, userError }, { status: 401 }),
    );
    const { result } = renderFlow(useFlow);
    await waitFor(() => expect(result.current.auth.isLoading).toBe(false));

    let returned!: Result;
    await act(async () => {
      returned = await result.current.flow.run(credentials);
    });

    expect(returned).toEqual({ success: false, userError });
    expect(result.current.auth.isAuthenticated).toBe(false);
  });

  test("a tokens-and-error-free reply folds into OTHER_ERROR", async () => {
    fetchMock.mockResolvedValue(
      Response.json({ tokens: null }, { status: 401 }),
    );
    const { result } = renderFlow(useFlow);
    await waitFor(() => expect(result.current.auth.isLoading).toBe(false));

    let returned!: Result;
    await act(async () => {
      returned = await result.current.flow.run(credentials);
    });

    expect(returned).toMatchObject({
      success: false,
      userError: { error: "OTHER_ERROR" },
    });
    expect(result.current.auth.isAuthenticated).toBe(false);
  });

  test("a thrown fetch folds into OTHER_ERROR preserving cause", async () => {
    const cause = new Error("network blip");
    fetchMock.mockRejectedValue(cause);
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
    let resolveFetch: (value: Response) => void;
    fetchMock.mockReturnValue(
      new Promise((resolve) => {
        resolveFetch = resolve;
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
      resolveFetch!(Response.json({ tokens: slimBundle }));
      await pending;
    });
    expect(result.current.flow.pending).toBe(false);
  });

  test("pending resets to false when the fetch throws", async () => {
    fetchMock.mockRejectedValue(new Error("boom"));
    const { result } = renderFlow(useFlow);
    await waitFor(() => expect(result.current.auth.isLoading).toBe(false));

    await act(async () => {
      await result.current.flow.run(credentials);
    });
    expect(result.current.flow.pending).toBe(false);
  });
});

test("a custom route overrides the default", async () => {
  fetchMock.mockResolvedValue(Response.json({ tokens: slimBundle }));
  const { result } = renderFlow(() => {
    const { signIn, pending } = useSignInWithPassword({
      route: "/custom/signin",
    });
    return { run: signIn, pending };
  });
  await waitFor(() => expect(result.current.auth.isLoading).toBe(false));

  await act(async () => {
    await result.current.flow.run(credentials);
  });
  expect(fetchMock).toHaveBeenCalledWith("/custom/signin", expect.anything());
});
