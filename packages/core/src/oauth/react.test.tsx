// @vitest-environment jsdom
import { act, renderHook, waitFor } from "@testing-library/react";
import { getFunctionName, makeFunctionReference } from "convex/server";
import { ReactNode, StrictMode } from "react";
import { afterEach, describe, expect, test, vi } from "vitest";
import type { MutationCaller } from "../browser/providerSetup";
import { AuthClient } from "../browser/sessionManager";
import { InMemoryStorage, NamespacedStorage } from "../browser/storage";
import type { TokenBundle } from "../lib/types";
import { useAuthToken } from "../react";
import { AuthProvider, useAuth } from "../react/client";
import {
  oauth,
  useOauth,
  useSignInWithGoogle,
  type OauthProviderApi,
} from "./react";

const NAMESPACE = "https://happy-animal-123.convex.cloud";

const bundle: TokenBundle = {
  accessToken: "access-1",
  accessTokenExpiresAt: 0,
  refreshToken: "refresh-1",
  refreshTokenExpiresAt: 0,
  userId: "user-1",
};

// Real function references, typed the way the generated `api.auth` exports
// them. The start leg passes `startSignIn` through by identity; completion
// rebuilds `completeSignIn` from the persisted path.
const googleStart = makeFunctionReference<"mutation">(
  "auth:startSignInGoogle",
) as OauthProviderApi["startSignIn"];
const googleComplete = makeFunctionReference<"mutation">(
  "auth:completeSignInGoogle",
) as OauthProviderApi["completeSignIn"];

/** The slice of a generated `api.auth` the Google hook reads. */
const TYPED_API = {
  startSignInGoogle: googleStart,
  completeSignInGoogle: googleComplete,
};

/** Store a pending flow the way `signIn` would before navigating away. */
function seedPendingFlow(
  storage: InMemoryStorage,
  {
    providerName = "google",
    state = "state-1",
    completeSignIn = "auth:completeSignInGoogle",
  } = {},
) {
  void new NamespacedStorage(storage, NAMESPACE).set(
    "__convexAuthOauthFlow",
    JSON.stringify({ providerName, state, completeSignIn }),
  );
}

/**
 * Render the tree the way `ConvexAuthProvider` wires it: run the setups while
 * constructing the client, pass collected onMounts to `AuthProvider`.
 */
function renderOAuth({
  storage = new InMemoryStorage(),
  strictMode = false,
  onMutation,
}: {
  storage?: InMemoryStorage;
  strictMode?: boolean;
  /** Configure the mutation mock before render (mount effects call it). */
  onMutation?: (mutation: ReturnType<typeof vi.fn>) => void;
} = {}) {
  const client = new AuthClient({
    mode: "spa",
    authApi: { refreshSession: async () => null, signOut: async () => {} },
    storage,
    storageNamespace: NAMESPACE,
  });
  const mutation = vi.fn();
  onMutation?.(mutation);
  const registration = oauth()({
    client,
    mutation: mutation as unknown as MutationCaller,
  }) as { onMount: () => void };
  const tree = (children: ReactNode) => (
    <AuthProvider authClient={client} onMounts={[registration.onMount]}>
      {children}
    </AuthProvider>
  );
  const wrapper = ({ children }: { children: ReactNode }) =>
    strictMode ? <StrictMode>{tree(children)}</StrictMode> : tree(children);
  const rendered = renderHook(
    () => ({
      auth: useAuth(),
      token: useAuthToken(),
      oauth: useSignInWithGoogle(TYPED_API),
      flowError: useOauth().flowError,
    }),
    { wrapper },
  );
  return { ...rendered, client, mutation, storage };
}

describe("OAuth React client", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    window.history.replaceState(null, "", "/");
    // Restore the prototype getter shadowed by the React Native stub.
    delete (window.navigator as { product?: string }).product;
  });

  test("the hooks throw when oauth() is not registered", () => {
    const client = new AuthClient({
      mode: "spa",
      authApi: { refreshSession: async () => null, signOut: async () => {} },
      storage: new InMemoryStorage(),
      storageNamespace: NAMESPACE,
    });
    const wrapper = ({ children }: { children: ReactNode }) => (
      <AuthProvider authClient={client}>{children}</AuthProvider>
    );
    expect(() =>
      renderHook(() => useSignInWithGoogle(TYPED_API), { wrapper }),
    ).toThrow(/No OAuth setup is registered/);
    expect(() => renderHook(() => useOauth(), { wrapper })).toThrow(
      /No OAuth setup is registered/,
    );
  });

  test("StrictMode double-mount redeems a callback code once", async () => {
    window.history.replaceState(null, "", "/?convexAuthCode=code-1");
    const storage = new InMemoryStorage();
    seedPendingFlow(storage);

    const { result, mutation } = renderOAuth({
      storage,
      strictMode: true,
      onMutation: (mutation) => mutation.mockResolvedValueOnce(bundle),
    });

    await waitFor(() => expect(result.current.auth.isAuthenticated).toBe(true));
    expect(mutation).toHaveBeenCalledOnce();
    // Completion rebuilt the reference from the persisted function path.
    expect(getFunctionName(mutation.mock.calls[0]![0] as never)).toBe(
      "auth:completeSignInGoogle",
    );
    expect(mutation.mock.calls[0]![1]).toEqual({
      code: "code-1",
      state: "state-1",
    });
    expect(result.current.token).toBe("access-1");
    expect(result.current.flowError).toBeNull();
    expect(window.location.search).toBe("");
  });

  test("a callback error param reaches useOauth's flowError", async () => {
    window.history.replaceState(null, "", "/?convexAuthError=access_denied");

    const { result, mutation } = renderOAuth();

    await waitFor(() =>
      expect(result.current.flowError?.code).toBe("access_denied"),
    );
    expect(result.current.flowError?.message).toBe("Sign-in was cancelled.");
    expect(mutation).not.toHaveBeenCalled();
  });

  test("signIn from the hook starts a flow with the picked references", async () => {
    // The React Native branch returns the URL instead of navigating, which
    // also keeps jsdom (no navigation support) happy.
    Object.defineProperty(window.navigator, "product", {
      value: "ReactNative",
      configurable: true,
    });
    const { result, mutation, storage } = renderOAuth();
    await waitFor(() => expect(result.current.auth.isLoading).toBe(false));
    mutation.mockResolvedValueOnce({
      redirect: "https://provider.example/auth?client_id=x",
      state: "state-1",
    });

    const outcome = await act(async () => {
      return await result.current.oauth.signInGoogle({
        redirectTo: "http://localhost/app",
      });
    });

    expect(mutation).toHaveBeenCalledExactlyOnceWith(googleStart, {
      redirectTo: "http://localhost/app",
    });
    expect(outcome).toEqual({
      redirect: new URL("https://provider.example/auth?client_id=x"),
    });
    // The persisted flow carries the completeSignIn function path, so
    // completion can run on a page that never mounted the hook.
    expect(
      new NamespacedStorage(storage, NAMESPACE).get("__convexAuthOauthFlow"),
    ).toBe(
      JSON.stringify({
        providerName: "google",
        state: "state-1",
        completeSignIn: "auth:completeSignInGoogle",
      }),
    );
  });

  test("renamed exports pass through the hook's canonical keys", async () => {
    Object.defineProperty(window.navigator, "product", {
      value: "ReactNative",
      configurable: true,
    });
    // An app that re-exported the functions under other names maps them onto
    // the hook's canonical parameter keys; the references pass through as-is.
    const renamedStart = makeFunctionReference<"mutation">(
      "auth:begin",
    ) as OauthProviderApi["startSignIn"];
    const renamedComplete = makeFunctionReference<"mutation">(
      "auth:finish",
    ) as OauthProviderApi["completeSignIn"];
    const client = new AuthClient({
      mode: "spa",
      authApi: { refreshSession: async () => null, signOut: async () => {} },
      storage: new InMemoryStorage(),
      storageNamespace: NAMESPACE,
    });
    const mutation = vi.fn().mockResolvedValueOnce({
      redirect: "https://provider.example/auth",
      state: "state-1",
    });
    const registration = oauth()({
      client,
      mutation: mutation as unknown as MutationCaller,
    }) as { onMount: () => void };
    const wrapper = ({ children }: { children: ReactNode }) => (
      <AuthProvider authClient={client} onMounts={[registration.onMount]}>
        {children}
      </AuthProvider>
    );
    const { result } = renderHook(
      () =>
        useSignInWithGoogle({
          startSignInGoogle: renamedStart,
          completeSignInGoogle: renamedComplete,
        }),
      { wrapper },
    );

    await act(async () => {
      await result.current.signInGoogle({ redirectTo: "http://localhost/app" });
    });

    expect(mutation).toHaveBeenCalledExactlyOnceWith(renamedStart, {
      redirectTo: "http://localhost/app",
    });
  });

  test("signInGoogle keeps a stable identity across rerenders", async () => {
    const { result, rerender } = renderOAuth();
    await waitFor(() => expect(result.current.auth.isLoading).toBe(false));
    const first = result.current.oauth.signInGoogle;

    rerender();

    // TYPED_API's references are module constants here, but the memo keys on
    // the function *paths*, so this holds for per-access generated api
    // proxies too.
    expect(result.current.oauth.signInGoogle).toBe(first);
  });

  test("the hook params accept the api module structurally", () => {
    type GoogleParam = Parameters<typeof useSignInWithGoogle>[0];
    // A full api module with extra keys (other providers, signOut) is
    // accepted; the hook reads only its two canonical keys. Assigned from a
    // variable, not a literal, so excess-property checking doesn't apply,
    // matching how `api.auth` reaches the hook.
    const apiModule = {
      ...TYPED_API,
      signOut: undefined as unknown,
      startSignInGithub: undefined as unknown,
    };
    const full: GoogleParam = apiModule;
    void full;
    // @ts-expect-error - missing completeSignInGoogle must not typecheck.
    const missing: GoogleParam = { startSignInGoogle: googleStart };
    void missing;
  });
});
