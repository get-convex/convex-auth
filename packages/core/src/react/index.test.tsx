// @vitest-environment jsdom
import { render, waitFor } from "@testing-library/react";
import { ConvexReactClient } from "convex/react";
import { makeFunctionReference } from "convex/server";
import { StrictMode, useEffect } from "react";
import { beforeEach, describe, expect, test, vi } from "vitest";
import {
  InMemoryStorage,
  JWT_STORAGE_KEY,
  NamespacedStorage,
  REFRESH_TOKEN_STORAGE_KEY,
} from "../browser/storage.ts";
import {
  ConvexAuthProvider,
  createAuthClient,
  useAuthClient,
} from "./index.tsx";

const URL = "https://happy-animal-123.convex.cloud";

const API = {
  refreshSession: makeFunctionReference<"mutation">("auth:refreshSession"),
  signOut: makeFunctionReference<"mutation">("auth:signOut"),
};

const SIGN_IN = makeFunctionReference<"mutation">("auth:signInProbe");

/** An auth client with in-memory storage. */
function makeAuthClient() {
  return createAuthClient({
    url: URL,
    api: API,
    storage: new InMemoryStorage(),
  });
}

/** A WebSocket stand-in that records sent messages and opens on request. */
class FakeWebSocket {
  static instances: FakeWebSocket[] = [];
  sent: string[] = [];
  onopen: ((event: Event) => void) | null = null;
  onclose: ((event: CloseEvent) => void) | null = null;
  onmessage: ((event: MessageEvent) => void) | null = null;
  onerror: ((event: Event) => void) | null = null;
  constructor(public url: string) {
    FakeWebSocket.instances.push(this);
  }
  send(data: string) {
    this.sent.push(data);
  }
  close() {
    this.onclose?.(new CloseEvent("close", { code: 1000 }));
  }
}

const webSocketConstructor = FakeWebSocket as unknown as typeof WebSocket;

/** A real Convex client against a fake deployment URL and a fake socket. */
function makeConvexClient() {
  return new ConvexReactClient(URL, { webSocketConstructor });
}

/** Fires the open event once on a fake socket. */
function open(socket: FakeWebSocket) {
  socket.onopen?.(new Event("open"));
}

/** The message types a fake socket sent, in order. */
function sentTypes(socket: FakeWebSocket): unknown[] {
  return socket.sent.map((m) => (JSON.parse(m) as { type: unknown }).type);
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
  describe("over a websocket", () => {
    beforeEach(() => {
      FakeWebSocket.instances = [];
    });

    test("a signed-out sign-in mutation is sent under expectAuth", async () => {
      const client = new ConvexReactClient(URL, {
        expectAuth: true,
        webSocketConstructor,
      });
      const auth = makeAuthClient();
      const setAuth = vi.spyOn(client, "setAuth");
      render(
        <ConvexAuthProvider client={client} auth={auth}>
          <div />
        </ConvexAuthProvider>,
      );
      await waitFor(() => expect(auth.getSnapshot().isLoading).toBe(false));
      void auth.signIn.mutation(SIGN_IN, {});
      await waitFor(() => expect(FakeWebSocket.instances).toHaveLength(1));
      const socket = FakeWebSocket.instances[0]!;
      open(socket);
      await waitFor(() => expect(sentTypes(socket)).toContain("Mutation"));
      expect(setAuth).toHaveBeenCalledOnce();
      expect(setAuth.mock.calls[0]![0]).toBe(auth.fetchAccessToken);
      void client.close();
    });

    test("a signed-in session sets auth once through the Convex provider", async () => {
      const storage = new InMemoryStorage();
      const sessionStorage = new NamespacedStorage(storage, URL);
      sessionStorage.set(JWT_STORAGE_KEY, "access-0");
      sessionStorage.set(REFRESH_TOKEN_STORAGE_KEY, "refresh-0");
      const auth = createAuthClient({ url: URL, api: API, storage });
      const client = new ConvexReactClient(URL, {
        expectAuth: true,
        webSocketConstructor,
      });
      const setAuth = vi.spyOn(client, "setAuth");
      render(
        <ConvexAuthProvider client={client} auth={auth}>
          <div />
        </ConvexAuthProvider>,
      );
      await waitFor(() =>
        expect(auth.getSnapshot()).toMatchObject({
          isLoading: false,
          isAuthenticated: true,
        }),
      );
      await waitFor(() => expect(setAuth).toHaveBeenCalled());
      // The Convex provider passes three arguments and this provider passes two.
      expect(setAuth).toHaveBeenCalledOnce();
      expect(setAuth.mock.calls[0]).toHaveLength(3);
      void client.close();
    });

    test("a signed-out sign-in mutation is sent without expectAuth", async () => {
      const client = new ConvexReactClient(URL, { webSocketConstructor });
      const auth = makeAuthClient();
      const setAuth = vi.spyOn(client, "setAuth");
      render(
        <ConvexAuthProvider client={client} auth={auth}>
          <div />
        </ConvexAuthProvider>,
      );
      await waitFor(() => expect(auth.getSnapshot().isLoading).toBe(false));
      void auth.signIn.mutation(SIGN_IN, {});
      await waitFor(() => expect(FakeWebSocket.instances).toHaveLength(1));
      const socket = FakeWebSocket.instances[0]!;
      open(socket);
      await waitFor(() => expect(sentTypes(socket)).toContain("Mutation"));
      expect(setAuth.mock.calls.length).toBeLessThanOrEqual(1);
      void client.close();
    });
  });
});
