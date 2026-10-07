// @vitest-environment jsdom
import { cleanup, render, waitFor } from "@testing-library/react";
import { ConvexReactClient, type ConvexReactClientOptions } from "convex/react";
import { makeFunctionReference } from "convex/server";
import { afterEach, describe, expect, test, vi } from "vitest";
import { InMemoryStorage } from "../browser/storage.ts";
import { makeSlimBundle } from "../lib/types.ts";
import {
  useOauth,
  useSignInWithGithub,
  type OauthProviderApi,
} from "../oauth/react.ts";
import {
  NAMESPACE,
  bundle,
  restoreNavigatorProduct,
  seedPendingFlow,
  stubReactNative,
} from "../oauth/testFlow.ts";
import { ConvexAuthNextjsProvider, useAuthToken } from "./index.tsx";

const githubApi = {
  startSignInGithub: makeFunctionReference<"mutation">(
    "auth:startSignInGithub",
  ) as OauthProviderApi["startSignIn"],
  completeSignInGithub: makeFunctionReference<"mutation">(
    "auth:completeSignInGithub",
  ) as OauthProviderApi["completeSignIn"],
};

const slim = makeSlimBundle(bundle);

/** Stub `fetch` so the sign-in proxy answers in the Convex HTTP format. */
function stubProxy(value: unknown) {
  const fetchMock = vi.fn(
    async (_url: string, _init: RequestInit) =>
      new Response(JSON.stringify({ status: "success", value, logLines: [] }), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
  );
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

/** A real Convex client whose calls are mocks, so no socket opens. */
function makeConvexClient(options?: ConvexReactClientOptions) {
  const client = new ConvexReactClient(NAMESPACE, options);
  const mutation = vi.spyOn(client, "mutation");
  vi.spyOn(client, "setAuth").mockImplementation(() => {});
  vi.spyOn(client, "clearAuth").mockImplementation(() => {});
  return { client, mutation };
}

describe("OAuth under ConvexAuthNextjsProvider", () => {
  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
    window.history.replaceState(null, "", "/");
    restoreNavigatorProduct();
  });

  test("startSignIn runs on the Convex client, not the proxy", async () => {
    stubReactNative();
    const fetchMock = stubProxy(null);
    const { client, mutation } = makeConvexClient();
    mutation.mockResolvedValue({
      redirect: "https://github.com/login/oauth/authorize",
      state: "state-1",
    });
    let signInGithub!: ReturnType<typeof useSignInWithGithub>["signInGithub"];
    function Probe() {
      ({ signInGithub } = useSignInWithGithub(githubApi));
      return null;
    }
    render(
      <ConvexAuthNextjsProvider client={client} storage={new InMemoryStorage()}>
        <Probe />
      </ConvexAuthNextjsProvider>,
    );

    await signInGithub({ redirectTo: "http://localhost/signin" });

    expect(mutation).toHaveBeenCalledWith(githubApi.startSignInGithub, {
      redirectTo: "http://localhost/signin",
    });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  test("startSignIn rejects instead of hanging when the client expects auth", async () => {
    stubReactNative();
    stubProxy(null);
    const { client, mutation } = makeConvexClient({ expectAuth: true });
    let signInGithub!: ReturnType<typeof useSignInWithGithub>["signInGithub"];
    let flowError: unknown;
    function Probe() {
      ({ signInGithub } = useSignInWithGithub(githubApi));
      flowError = useOauth().flowError;
      return null;
    }
    render(
      <ConvexAuthNextjsProvider client={client} storage={new InMemoryStorage()}>
        <Probe />
      </ConvexAuthNextjsProvider>,
    );

    await expect(
      signInGithub({ redirectTo: "http://localhost/signin" }),
    ).rejects.toThrow(/expectAuth/);

    expect(mutation).not.toHaveBeenCalled();
    await waitFor(() =>
      expect(flowError).toMatchObject({ code: "oauth_error" }),
    );
  });

  test("a callback code redeems through the proxy and signs in", async () => {
    window.history.replaceState(null, "", "/signin?convexAuthCode=code-1");
    const storage = new InMemoryStorage();
    seedPendingFlow(storage, {
      providerName: "github",
      startSignIn: githubApi.startSignInGithub,
      completeSignIn: githubApi.completeSignInGithub,
    });
    const fetchMock = stubProxy({ status: "complete", tokens: slim });
    const { client, mutation } = makeConvexClient();
    let token: string | null = null;
    let flowError: unknown;
    function Probe() {
      token = useAuthToken();
      flowError = useOauth().flowError;
      return null;
    }
    render(
      <ConvexAuthNextjsProvider client={client} storage={storage}>
        <Probe />
      </ConvexAuthNextjsProvider>,
    );

    await waitFor(() => expect(token).toBe(bundle.accessToken));
    expect(flowError).toBeNull();
    expect(mutation).not.toHaveBeenCalled();
    expect(fetchMock).toHaveBeenCalledOnce();
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe("/auth/signin?path=/api/mutation");
    expect(JSON.parse(init.body as string)).toMatchObject({
      path: "auth:completeSignInGithub",
      args: [{ code: "code-1", state: "state-1" }],
    });
    expect(window.location.search).toBe("");
  });
});
