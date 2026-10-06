// @vitest-environment jsdom
import {
  act,
  cleanup,
  render,
  renderHook,
  screen,
  waitFor,
} from "@testing-library/react";
import { ConvexProvider, ConvexReactClient } from "convex/react";
import { anyApi, makeFunctionReference } from "convex/server";
import { ReactNode, StrictMode } from "react";
import { afterEach, describe, expect, test, vi } from "vitest";
import { AuthClient, type AuthState } from "../browser/sessionManager.ts";
import type { AuthSignInApi } from "../browser/signInApi.ts";
import { InMemoryStorage } from "../browser/storage.ts";
import type { SlimTokenBundle } from "../lib/types.ts";
import { useAuthToken } from "../react/index.tsx";
import { AuthProvider, useAuth } from "../react/client.tsx";
import {
  useOauth,
  useOauthCallback,
  useOauthSignIn,
  useSignInWithGithub,
  useSignInWithGoogle,
  type OauthProviderApi,
  type OauthProviderRefs,
} from "./react.ts";
import {
  acmeRefs,
  NAMESPACE,
  calledPath,
  completed,
  oauthContext,
  readFlow,
  restoreNavigatorProduct,
  seedPendingFlow,
  stubReactNative,
} from "./testFlow.ts";

// Function references with the paths a generated `api.auth` would have. Nothing
// resolves them. Both clients are mocks, so these are addresses the assertions
// compare.
const googleStart = makeFunctionReference<"mutation">(
  "auth:startSignInGoogle",
) as OauthProviderApi["startSignIn"];
const googleComplete = makeFunctionReference<"mutation">(
  "auth:completeSignInGoogle",
) as OauthProviderApi["completeSignIn"];

/** The part of a generated `api.auth` the Google hook reads. */
const googleApi = {
  startSignInGoogle: googleStart,
  completeSignInGoogle: googleComplete,
};

/** The part of a generated `api.auth` the GitHub hook reads. */
const githubApi = {
  startSignInGithub: makeFunctionReference<"mutation">(
    "auth:startSignInGithub",
  ) as OauthProviderApi["startSignIn"],
  completeSignInGithub: makeFunctionReference<"mutation">(
    "auth:completeSignInGithub",
  ) as OauthProviderApi["completeSignIn"],
};

/** What the Google hook builds from {@link googleApi}, for seeding a flow. */
const googleRefs: OauthProviderRefs = {
  providerName: "google",
  startSignIn: googleStart,
  completeSignIn: googleComplete,
};

/** Auth state plus the Google sign-in, which most tests here read. */
function useGoogleFlow(api = googleApi) {
  return {
    auth: useAuth(),
    token: useAuthToken(),
    oauth: useSignInWithGoogle(api),
    flowError: useOauth().flowError,
  };
}

/**
 * A real Convex client against a fake deployment URL, with its `mutation`
 * spied on. Nothing subscribes, and every call the tests make is mocked, so
 * it never opens a connection.
 */
function makeConvexClient() {
  const convexClient = new ConvexReactClient(NAMESPACE);
  const startMutation = vi.spyOn(convexClient, "mutation");
  return { convexClient, startMutation };
}

/** The provider tree the way `ConvexAuthProvider` sets it up. */
function makeWrapper(
  convexClient: ConvexReactClient,
  auth: AuthClient,
  strictMode: boolean,
) {
  const tree = (children: ReactNode) => (
    <ConvexProvider client={convexClient}>
      <AuthProvider authClient={auth}>{children}</AuthProvider>
    </ConvexProvider>
  );
  return ({ children }: { children: ReactNode }) =>
    strictMode ? <StrictMode>{tree(children)}</StrictMode> : tree(children);
}

/** Render `hook` inside the provider tree with an SPA auth client. */
function renderOAuth<T>(
  hook: () => T,
  {
    storage = new InMemoryStorage(),
    strictMode = false,
  }: { storage?: InMemoryStorage; strictMode?: boolean } = {},
) {
  const { convexClient, startMutation } = makeConvexClient();
  const { auth, completeMutation } = oauthContext({
    storage,
    convex: convexClient,
  });
  const rendered = renderHook(hook, {
    wrapper: makeWrapper(convexClient, auth, strictMode),
  });
  return { ...rendered, auth, completeMutation, startMutation, storage };
}

describe("OAuth React client", () => {
  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
    window.history.replaceState(null, "", "/");
    restoreNavigatorProduct();
  });

  test("the hooks throw outside a provider", () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    expect(() => renderHook(() => useSignInWithGoogle(googleApi))).toThrow(
      /must be used within/,
    );
    expect(() => renderHook(() => useOauthCallback())).toThrow(
      /must be used within/,
    );
    expect(() => renderHook(() => useOauth())).toThrow(/must be used within/);
  });

  test("StrictMode double mount redeems a callback code once", async () => {
    window.history.replaceState(null, "", "/?convexAuthCode=code-1");
    const storage = new InMemoryStorage();
    seedPendingFlow(storage, googleRefs);
    const { convexClient, startMutation } = makeConvexClient();
    const { auth, completeMutation } = oauthContext({
      storage,
      convex: convexClient,
    });
    completeMutation.mockResolvedValueOnce(completed);

    const { result } = renderHook(useGoogleFlow, {
      wrapper: makeWrapper(convexClient, auth, true),
    });

    await waitFor(() => expect(result.current.auth.isAuthenticated).toBe(true));
    expect(completeMutation).toHaveBeenCalledOnce();
    // Completion rebuilt the reference from the stored function path.
    expect(calledPath(completeMutation)).toBe("auth:completeSignInGoogle");
    expect(completeMutation.mock.calls[0]![1]).toEqual({
      code: "code-1",
      state: "state-1",
    });
    expect(startMutation).not.toHaveBeenCalled();
    expect(result.current.token).toBe("access-1");
    expect(result.current.flowError).toBeNull();
    expect(window.location.search).toBe("");
  });

  test("the auth state never reports signed out while a callback code is redeemed", async () => {
    window.history.replaceState(null, "", "/?convexAuthCode=code-1");
    const storage = new InMemoryStorage();
    seedPendingFlow(storage, googleRefs);
    const { convexClient } = makeConvexClient();
    const { auth, completeMutation } = oauthContext({
      storage,
      convex: convexClient,
    });
    const redemption = Promise.withResolvers<typeof completed>();
    completeMutation.mockReturnValueOnce(redemption.promise);
    const init = vi.spyOn(auth, "init");

    // Both the store snapshots and the rendered state must stay loading until
    // the session is stored.
    const snapshots: AuthState[] = [];
    auth.subscribe(() => snapshots.push(auth.getSnapshot()));
    const rendered: Array<{ isLoading: boolean; isAuthenticated: boolean }> =
      [];
    const { result } = renderHook(
      () => {
        const { isLoading, isAuthenticated } = useAuth();
        rendered.push({ isLoading, isAuthenticated });
        useSignInWithGoogle(googleApi);
        return { isAuthenticated };
      },
      { wrapper: makeWrapper(convexClient, auth, true) },
    );

    // The session load is done here and the redemption is not.
    await act(async () => {
      await Promise.all(init.mock.results.map((r) => r.value));
    });
    expect(init).toHaveBeenCalled();
    expect(auth.getSnapshot().isLoading).toBe(true);

    redemption.resolve(completed);
    await waitFor(() => expect(result.current.isAuthenticated).toBe(true));

    const signedOut = (s: { isLoading: boolean; isAuthenticated: boolean }) =>
      !s.isLoading && !s.isAuthenticated;
    expect(snapshots.filter(signedOut)).toEqual([]);
    expect(rendered.filter(signedOut)).toEqual([]);
  });

  test("a callback error param reaches useOauth in a sibling component", async () => {
    window.history.replaceState(null, "", "/?convexAuthError=access_denied");
    const { convexClient } = makeConvexClient();
    const { auth, completeMutation } = oauthContext({ convex: convexClient });
    function ErrorBanner() {
      const { flowError } = useOauth();
      return <div>{flowError?.code ?? "no error"}</div>;
    }
    function SignInButton() {
      useSignInWithGoogle(googleApi);
      return null;
    }
    const Wrapper = makeWrapper(convexClient, auth, false);

    render(
      <Wrapper>
        <ErrorBanner />
        <SignInButton />
      </Wrapper>,
    );

    expect(await screen.findByText("access_denied")).toBeDefined();
    expect(completeMutation).not.toHaveBeenCalled();
    expect(window.location.search).toBe("");
  });

  test("signInGoogle starts a flow through the ConvexProvider client", async () => {
    stubReactNative();
    const { result, completeMutation, startMutation, storage } =
      renderOAuth(useGoogleFlow);
    await waitFor(() => expect(result.current.auth.isLoading).toBe(false));
    startMutation.mockResolvedValueOnce({
      redirect: "https://provider.example/auth?client_id=x",
      state: "state-1",
    } as never);

    const outcome = await act(async () => {
      return await result.current.oauth.signInGoogle({
        redirectTo: "http://localhost/app",
      });
    });

    expect(startMutation).toHaveBeenCalledExactlyOnceWith(googleStart, {
      redirectTo: "http://localhost/app",
    });
    // The auth client's sign-in API runs only functions that return the
    // shared sign-in result.
    expect(completeMutation).not.toHaveBeenCalled();
    expect(outcome).toEqual({
      redirect: new URL("https://provider.example/auth?client_id=x"),
    });
    // The stored flow has the completeSignIn function path, so completion can
    // run on a page that never mounted the hook.
    expect(readFlow(storage)).toEqual({
      providerName: "google",
      state: "state-1",
      completeSignIn: "auth:completeSignInGoogle",
    });
  });

  test("signInGithub starts a flow with the GitHub references", async () => {
    stubReactNative();
    const { result, startMutation, storage } = renderOAuth(() => ({
      auth: useAuth(),
      oauth: useSignInWithGithub(githubApi),
    }));
    await waitFor(() => expect(result.current.auth.isLoading).toBe(false));
    startMutation.mockResolvedValueOnce({
      redirect: "https://github.example/auth",
      state: "state-2",
    } as never);

    await act(async () => {
      await result.current.oauth.signInGithub({
        redirectTo: "http://localhost/app",
      });
    });

    expect(startMutation).toHaveBeenCalledExactlyOnceWith(
      githubApi.startSignInGithub,
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
    const { result, startMutation, storage } = renderOAuth(() => ({
      auth: useAuth(),
      oauth: useOauthSignIn(acmeRefs),
    }));
    await waitFor(() => expect(result.current.auth.isLoading).toBe(false));
    startMutation.mockResolvedValueOnce({
      redirect: "https://acme.example/auth",
      state: "state-3",
    } as never);

    const outcome = await act(async () => {
      return await result.current.oauth.signIn({
        redirectTo: "http://localhost/app",
      });
    });

    expect(startMutation).toHaveBeenCalledExactlyOnceWith(
      acmeRefs.startSignIn,
      {
        redirectTo: "http://localhost/app",
      },
    );
    expect(outcome).toEqual({
      redirect: new URL("https://acme.example/auth"),
    });
    expect(readFlow(storage)).toEqual({
      providerName: "acme",
      state: "state-3",
      completeSignIn: "auth:completeSignInAcme",
    });
  });

  test("an ssr-mode client completes through its sign-in API and starts through the ConvexProvider client", async () => {
    window.history.replaceState(null, "", "/?convexAuthCode=code-1");
    stubReactNative();
    const storage = new InMemoryStorage();
    seedPendingFlow(storage, googleRefs);
    // The stand-in for the Next.js auth proxy, which returns an access-only
    // session.
    const slim: SlimTokenBundle = {
      accessToken: "access-ssr",
      accessTokenExpiresAt: 0,
      userId: "user-1",
    };
    const proxyMutation = vi
      .fn()
      .mockResolvedValueOnce({ status: "complete", tokens: slim });
    const { convexClient, startMutation } = makeConvexClient();
    const auth = new AuthClient({
      mode: "ssr",
      convex: convexClient,
      url: NAMESPACE,
      signInApi: {
        mutation: proxyMutation,
        action: vi.fn(),
      } as unknown as AuthSignInApi,
      authApi: { refreshSession: async () => null, signOut: async () => {} },
      storage,
      storageNamespace: NAMESPACE,
    });

    const { result } = renderHook(useGoogleFlow, {
      wrapper: makeWrapper(convexClient, auth, false),
    });

    await waitFor(() => expect(result.current.auth.isAuthenticated).toBe(true));
    expect(result.current.token).toBe("access-ssr");
    expect(proxyMutation).toHaveBeenCalledOnce();
    expect(calledPath(proxyMutation)).toBe("auth:completeSignInGoogle");
    expect(startMutation).not.toHaveBeenCalled();

    startMutation.mockResolvedValueOnce({
      redirect: "https://provider.example/auth",
      state: "state-2",
    } as never);
    await act(async () => {
      await result.current.oauth.signInGoogle({
        redirectTo: "http://localhost/app",
      });
    });

    expect(startMutation).toHaveBeenCalledExactlyOnceWith(googleStart, {
      redirectTo: "http://localhost/app",
    });
    expect(proxyMutation).toHaveBeenCalledOnce();
  });

  test("signInGoogle keeps a stable identity across rerenders", async () => {
    // `anyApi` is what the generated `api` is, and it returns a new reference
    // object on every property access. The hook's memo has to key on the
    // function paths for the identity below to hold.
    const { result, rerender } = renderOAuth(() =>
      useGoogleFlow(anyApi.auth as unknown as typeof googleApi),
    );
    await waitFor(() => expect(result.current.auth.isLoading).toBe(false));
    const first = result.current.oauth.signInGoogle;

    rerender();

    expect(result.current.oauth.signInGoogle).toBe(first);
  });

  test("the hook params accept the api module structurally", () => {
    type GoogleParam = Parameters<typeof useSignInWithGoogle>[0];
    const apiModule = {
      ...googleApi,
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
