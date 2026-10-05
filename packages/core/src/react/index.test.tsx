// @vitest-environment jsdom
import { render, screen, waitFor } from "@testing-library/react";
import { ConvexReactClient } from "convex/react";
import { makeFunctionReference } from "convex/server";
import { StrictMode, useEffect } from "react";
import { describe, expect, test, vi } from "vitest";
import type {
  AmbientSignInClient,
  AuthSignInApi,
} from "../browser/ambientSignInClient.ts";
import { InMemoryStorage } from "../browser/storage.ts";
import { useOauth } from "../oauth/react.ts";
import {
  ConvexAuthProvider,
  createAuthClient,
  useAuthClient,
} from "./index.tsx";
import { useAmbientSignInValue } from "./providers.ts";

const URL = "https://happy-animal-123.convex.cloud";

const API = {
  refreshSession: makeFunctionReference<"mutation">("auth:refreshSession"),
  signOut: makeFunctionReference<"mutation">("auth:signOut"),
};

const SIGN_IN = makeFunctionReference<"mutation">("auth:signInProbe");

/**
 * A real Convex client against a fake deployment URL. Nothing here
 * authenticates or subscribes, so it never opens a connection.
 */
function makeConvexClient() {
  return new ConvexReactClient(URL);
}

/** An auth client with in-memory storage and the given ambient sign-ins. */
function makeAuthClient(ambientSignIns?: AmbientSignInClient[]) {
  return createAuthClient({
    url: URL,
    api: API,
    storage: new InMemoryStorage(),
    ambientSignIns,
  });
}

/** Renders the value a probe setup publishes under its scoped `status` key. */
function ProbeStatus() {
  const status = useAmbientSignInValue<string>("probe", "status");
  return <div>{status ?? "missing"}</div>;
}

/**
 * Renders the flow error from the default oauth setup. The hook throws when
 * oauth() was never registered, so rendering this at all is the assertion.
 */
function OauthFlowError() {
  return <div>{String(useOauth().flowError)}</div>;
}

describe("ConvexAuthProvider", () => {
  test("useAuthClient returns the auth client passed as a prop", () => {
    const auth = makeAuthClient();
    const seen: unknown[] = [];
    function Capture() {
      seen.push(useAuthClient());
      return null;
    }
    render(
      <ConvexAuthProvider client={makeConvexClient()} auth={auth}>
        <Capture />
      </ConvexAuthProvider>,
    );
    expect(seen[0]).toBe(auth);
  });

  test("auth.signIn.mutation runs on the Convex client", async () => {
    const client = makeConvexClient();
    const mutation = vi
      .spyOn(client, "mutation")
      .mockResolvedValue("result" as never);
    const auth = makeAuthClient();
    render(
      <ConvexAuthProvider client={client} auth={auth}>
        <div />
      </ConvexAuthProvider>,
    );
    await expect(auth.signIn.mutation(SIGN_IN, {})).resolves.toBe("result");
    expect(mutation).toHaveBeenCalledWith(SIGN_IN, {});
  });

  test("auth.signIn.action runs on the Convex client", async () => {
    const client = makeConvexClient();
    const action = vi
      .spyOn(client, "action")
      .mockResolvedValue("result" as never);
    const auth = makeAuthClient();
    const signInAction = makeFunctionReference<"action">("auth:signInAction");
    render(
      <ConvexAuthProvider client={client} auth={auth}>
        <div />
      </ConvexAuthProvider>,
    );
    await expect(auth.signIn.action(signInAction, {})).resolves.toBe("result");
    expect(action).toHaveBeenCalledWith(signInAction, {});
  });

  test("a child mount effect can call auth.signIn.mutation", async () => {
    const client = makeConvexClient();
    const mutation = vi
      .spyOn(client, "mutation")
      .mockResolvedValue("result" as never);
    const auth = makeAuthClient();
    const results: Promise<unknown>[] = [];
    function SignInOnMount() {
      const authClient = useAuthClient();
      useEffect(() => {
        // Child effects run before the provider's effects, so the API must be
        // set during the provider's render.
        results.push(authClient.signIn.mutation(SIGN_IN, {}));
      }, [authClient]);
      return null;
    }
    render(
      <ConvexAuthProvider client={client} auth={auth}>
        <SignInOnMount />
      </ConvexAuthProvider>,
    );
    expect(results).toHaveLength(1);
    await expect(results[0]).resolves.toBe("result");
    expect(mutation).toHaveBeenCalledWith(SIGN_IN, {});
  });

  test("a new client prop sets the sign-in API again", async () => {
    const first = makeConvexClient();
    const second = makeConvexClient();
    const firstMutation = vi
      .spyOn(first, "mutation")
      .mockResolvedValue("first" as never);
    const secondMutation = vi
      .spyOn(second, "mutation")
      .mockResolvedValue("second" as never);
    const auth = makeAuthClient();
    const { rerender } = render(
      <ConvexAuthProvider client={first} auth={auth}>
        <div />
      </ConvexAuthProvider>,
    );
    await expect(auth.signIn.mutation(SIGN_IN, {})).resolves.toBe("first");

    rerender(
      <ConvexAuthProvider client={second} auth={auth}>
        <div />
      </ConvexAuthProvider>,
    );

    await expect(auth.signIn.mutation(SIGN_IN, {})).resolves.toBe("second");
    expect(firstMutation).toHaveBeenCalledTimes(1);
    expect(secondMutation).toHaveBeenCalledTimes(1);
  });

  test("a StrictMode double render sets one working sign-in API", async () => {
    const client = makeConvexClient();
    const mutation = vi
      .spyOn(client, "mutation")
      .mockResolvedValue("result" as never);
    const auth = makeAuthClient();
    const setSignInApi = vi.spyOn(auth, "setSignInApi");
    render(
      <StrictMode>
        <ConvexAuthProvider client={client} auth={auth}>
          <div />
        </ConvexAuthProvider>
      </StrictMode>,
    );
    // StrictMode renders twice. Both renders set the same memoized wrapper.
    expect(setSignInApi).toHaveBeenCalledTimes(2);
    expect(setSignInApi.mock.calls[0]![0]).toBe(setSignInApi.mock.calls[1]![0]);
    await waitFor(() => expect(auth.getSnapshot().isLoading).toBe(false));
    await expect(auth.signIn.mutation(SIGN_IN, {})).resolves.toBe("result");
    expect(mutation).toHaveBeenCalledOnce();
  });
});

describe("ConvexAuthProvider ambient sign-ins", () => {
  test("published setup values are readable on the first render", () => {
    const probe: AmbientSignInClient = {
      id: "probe",
      setup: (ctx) => {
        ctx.values.set("status", "registered");
      },
    };
    render(
      <ConvexAuthProvider
        client={makeConvexClient()}
        auth={makeAuthClient([probe])}
      >
        <ProbeStatus />
      </ConvexAuthProvider>,
    );
    expect(screen.getByText("registered")).toBeDefined();
  });

  test("onInit runs once per client under StrictMode", () => {
    const onInit = vi.fn();
    const auth = makeAuthClient([{ id: "probe", setup: () => ({ onInit }) }]);
    render(
      <StrictMode>
        <ConvexAuthProvider client={makeConvexClient()} auth={auth}>
          <div />
        </ConvexAuthProvider>
      </StrictMode>,
    );
    expect(onInit).toHaveBeenCalledTimes(1);
  });

  test("setups receive the auth client's sign-in API", () => {
    const fromSetup: AuthSignInApi[] = [];
    const fromHook: AuthSignInApi[] = [];
    function Capture() {
      fromHook.push(useAuthClient().signIn);
      return null;
    }
    const auth = makeAuthClient([
      {
        id: "probe",
        setup: (ctx) => {
          fromSetup.push(ctx.signInApi);
        },
      },
    ]);
    render(
      <ConvexAuthProvider client={makeConvexClient()} auth={auth}>
        <Capture />
      </ConvexAuthProvider>,
    );
    expect(fromSetup[0]).toBe(auth.signIn);
    expect(fromHook[0]).toBe(auth.signIn);
  });

  test("createAuthClient registers oauth() by default", () => {
    render(
      <ConvexAuthProvider client={makeConvexClient()} auth={makeAuthClient()}>
        <OauthFlowError />
      </ConvexAuthProvider>,
    );
    expect(screen.getByText("null")).toBeDefined();
  });
});
