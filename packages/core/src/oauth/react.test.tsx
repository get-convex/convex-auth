// @vitest-environment jsdom
import { act, renderHook, waitFor } from "@testing-library/react";
import { anyApi, makeFunctionReference } from "convex/server";
import { ReactNode, StrictMode } from "react";
import { afterEach, describe, expect, test, vi } from "vitest";
import { AuthClient } from "../browser/sessionManager";
import { InMemoryStorage } from "../browser/storage";
import { useAuthToken } from "../react";
import { AuthProvider, useAuth } from "../react/client";
import { stubSignInApi } from "../react/testSignInApi";
import {
  useOauth,
  useOauthSignIn,
  useSignInWithGithub,
  useSignInWithGoogle,
  type OauthProviderApi,
  type OauthProviderRefs,
} from "./react";
import {
  ACME_REFS,
  NAMESPACE,
  bundle,
  calledPath,
  oauthClient,
  readFlow,
  restoreNavigatorProduct,
  seedPendingFlow,
  stubReactNative,
} from "./testFlow";

// Function references with the paths a generated `api.auth` would have. Nothing
// resolves them. The sign-in api is a mock, so these are addresses the
// assertions compare.
const googleStart = makeFunctionReference<"mutation">(
  "auth:startSignInGoogle",
) as OauthProviderApi["startSignIn"];
const googleComplete = makeFunctionReference<"mutation">(
  "auth:completeSignInGoogle",
) as OauthProviderApi["completeSignIn"];

/** The part of a generated `api.auth` the Google hook reads. */
const TYPED_API = {
  startSignInGoogle: googleStart,
  completeSignInGoogle: googleComplete,
};

/** The part of a generated `api.auth` the GitHub hook reads. */
const GITHUB_API = {
  startSignInGithub: makeFunctionReference<"mutation">(
    "auth:startSignInGithub",
  ) as OauthProviderApi["startSignIn"],
  completeSignInGithub: makeFunctionReference<"mutation">(
    "auth:completeSignInGithub",
  ) as OauthProviderApi["completeSignIn"],
};

/** What the Google hook builds from {@link TYPED_API}, for seeding a flow. */
const GOOGLE_REFS: OauthProviderRefs = {
  providerName: "google",
  startSignIn: googleStart,
  completeSignIn: googleComplete,
};

/** Auth state plus the Google sign-in, which most tests here read. */
function useGoogleFlow(api = TYPED_API) {
  return {
    auth: useAuth(),
    token: useAuthToken(),
    oauth: useSignInWithGoogle(api),
    flowError: useOauth().flowError,
  };
}

/** Render `hook` in the tree the way `ConvexAuthProvider` sets it up. */
function renderOAuth<T>(
  hook: () => T,
  {
    storage = new InMemoryStorage(),
    strictMode = false,
    onMutation,
  }: {
    storage?: InMemoryStorage;
    strictMode?: boolean;
    /** Configure the mutation mock before render (mount effects call it). */
    onMutation?: (mutation: ReturnType<typeof vi.fn>) => void;
  } = {},
) {
  const { client, signInApi, mutation } = oauthClient(storage);
  onMutation?.(mutation);
  const tree = (children: ReactNode) => (
    <AuthProvider authClient={client} signInApi={signInApi}>
      {children}
    </AuthProvider>
  );
  const wrapper = ({ children }: { children: ReactNode }) =>
    strictMode ? <StrictMode>{tree(children)}</StrictMode> : tree(children);
  const rendered = renderHook(hook, { wrapper });
  return { ...rendered, client, mutation, storage };
}

describe("OAuth React client", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    window.history.replaceState(null, "", "/");
    restoreNavigatorProduct();
  });

  test("the hooks throw when oauth() is not registered", () => {
    const client = new AuthClient({
      mode: "spa",
      authApi: { refreshSession: async () => null, signOut: async () => {} },
      storage: new InMemoryStorage(),
      storageNamespace: NAMESPACE,
    });
    const wrapper = ({ children }: { children: ReactNode }) => (
      <AuthProvider authClient={client} signInApi={stubSignInApi().signInApi}>
        {children}
      </AuthProvider>
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
    seedPendingFlow(storage, GOOGLE_REFS);

    const { result, mutation } = renderOAuth(useGoogleFlow, {
      storage,
      strictMode: true,
      onMutation: (mutation) => mutation.mockResolvedValueOnce(bundle),
    });

    await waitFor(() => expect(result.current.auth.isAuthenticated).toBe(true));
    expect(mutation).toHaveBeenCalledOnce();
    // Completion rebuilt the reference from the persisted function path.
    expect(calledPath(mutation)).toBe("auth:completeSignInGoogle");
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

    const { result, mutation } = renderOAuth(useGoogleFlow);

    await waitFor(() =>
      expect(result.current.flowError?.code).toBe("access_denied"),
    );
    expect(mutation).not.toHaveBeenCalled();
  });

  test("signIn from the hook starts a flow with the picked references", async () => {
    stubReactNative();
    const { result, mutation, storage } = renderOAuth(useGoogleFlow);
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
    expect(readFlow(storage)).toEqual({
      providerName: "google",
      state: "state-1",
      completeSignIn: "auth:completeSignInGoogle",
    });
  });

  test("signInGithub starts a flow with the GitHub references", async () => {
    stubReactNative();
    const { result, mutation, storage } = renderOAuth(() => ({
      auth: useAuth(),
      oauth: useSignInWithGithub(GITHUB_API),
    }));
    await waitFor(() => expect(result.current.auth.isLoading).toBe(false));
    mutation.mockResolvedValueOnce({
      redirect: "https://github.example/auth",
      state: "state-2",
    });

    await act(async () => {
      await result.current.oauth.signInGithub({
        redirectTo: "http://localhost/app",
      });
    });

    expect(mutation).toHaveBeenCalledExactlyOnceWith(
      GITHUB_API.startSignInGithub,
      { redirectTo: "http://localhost/app" },
    );
    expect(readFlow(storage)).toEqual({
      providerName: "github",
      state: "state-2",
      completeSignIn: "auth:completeSignInGithub",
    });
  });

  test("useOauthSignIn runs a provider that ships no hook of its own", async () => {
    stubReactNative();
    const { result, mutation, storage } = renderOAuth(() => ({
      auth: useAuth(),
      oauth: useOauthSignIn(ACME_REFS),
    }));
    await waitFor(() => expect(result.current.auth.isLoading).toBe(false));
    mutation.mockResolvedValueOnce({
      redirect: "https://acme.example/auth",
      state: "state-3",
    });

    const outcome = await act(async () => {
      return await result.current.oauth.signIn({
        redirectTo: "http://localhost/app",
      });
    });

    expect(mutation).toHaveBeenCalledExactlyOnceWith(ACME_REFS.startSignIn, {
      redirectTo: "http://localhost/app",
    });
    expect(outcome).toEqual({
      redirect: new URL("https://acme.example/auth"),
    });
    expect(readFlow(storage)).toEqual({
      providerName: "acme",
      state: "state-3",
      completeSignIn: "auth:completeSignInAcme",
    });
  });

  test("signInGoogle keeps a stable identity across rerenders", async () => {
    // `anyApi` is what the generated `api` is, and it returns a new reference
    // object on every property access. The hook's memo has to key on the
    // function paths for the identity below to hold.
    const { result, rerender } = renderOAuth(() =>
      useGoogleFlow(anyApi.auth as unknown as typeof TYPED_API),
    );
    await waitFor(() => expect(result.current.auth.isLoading).toBe(false));
    const first = result.current.oauth.signInGoogle;

    rerender();

    expect(result.current.oauth.signInGoogle).toBe(first);
  });

  test("the hook params accept the api module structurally", () => {
    type GoogleParam = Parameters<typeof useSignInWithGoogle>[0];
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
