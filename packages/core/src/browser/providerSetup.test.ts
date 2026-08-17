import { describe, expect, test, vi } from "vitest";
import {
  registerProviderClientSetups,
  type AuthProviderClientSetup,
  type AuthSignInApi,
} from "./providerSetup";
import { AuthClient } from "./sessionManager";
import { InMemoryStorage, NamespacedStorage } from "./storage";

/** A stub sign-in api. Setups here register it but never call it. */
const SIGN_IN_API = {
  mutation: vi.fn(),
  action: vi.fn(),
} as unknown as AuthSignInApi;

const NAMESPACE = "https://happy-animal-123.convex.cloud";

/** An {@link AuthClient} whose auth api is never exercised. */
function makeClient(storage = new InMemoryStorage()) {
  return new AuthClient({
    mode: "spa",
    authApi: { refreshSession: async () => null, signOut: async () => {} },
    storage,
    storageNamespace: NAMESPACE,
  });
}

/** Run `setups` against `client` with the stub sign-in api. */
function register(
  client: AuthClient,
  setups: ReadonlyArray<AuthProviderClientSetup>,
) {
  return registerProviderClientSetups({
    client,
    signInApi: SIGN_IN_API,
    setups,
  });
}

describe("registerProviderClientSetups", () => {
  test("throws when two setups share an id", () => {
    const client = makeClient();
    expect(() =>
      register(client, [
        { id: "oauth", setup: () => {} },
        { id: "oauth", setup: () => {} },
      ]),
    ).toThrow(/"oauth" is registered twice/);
  });

  test("throws when a setup id is not alphanumeric", () => {
    const client = makeClient();
    expect(() =>
      register(client, [{ id: "pass-key", setup: () => {} }]),
    ).toThrow(/"pass-key" is invalid/);
  });

  test("scoped store writes land under the setup id", () => {
    const client = makeClient();
    register(client, [
      {
        id: "oauth",
        setup: (ctx) => {
          ctx.store.set("actions", "registered");
        },
      },
    ]);
    expect(client.store.get<string>("oauth/actions")).toBe("registered");
  });

  test("scoped storage writes land under the provider prefix", () => {
    const storage = new InMemoryStorage();
    const client = makeClient(storage);
    register(client, [
      {
        id: "oauth",
        setup: (ctx) => {
          void ctx.storage.set("verifier", "v1");
        },
      },
    ]);
    // Provider prefix first, then the client's deployment namespacing.
    expect(
      storage.getItem(
        new NamespacedStorage(storage, NAMESPACE).key(
          "__convexAuthProvider_oauth_verifier",
        ),
      ),
    ).toBe("v1");
  });

  test("onStarts are collected in registration order", () => {
    const client = makeClient();
    const order: string[] = [];
    const onStarts = register(client, [
      { id: "a", setup: () => ({ onStart: () => order.push("a") }) },
      { id: "b", setup: () => {} },
      { id: "c", setup: () => ({ onStart: () => order.push("c") }) },
    ]);
    onStarts.forEach(({ onStart }) => onStart());
    expect(onStarts.map(({ id }) => id)).toEqual(["a", "c"]);
    expect(order).toEqual(["a", "c"]);
  });

  test("every setup receives the same sign-in api and client", () => {
    const client = makeClient();
    const received: Array<{ signInApi: AuthSignInApi; client: AuthClient }> =
      [];
    register(client, [
      {
        id: "a",
        setup: (ctx) => {
          received.push({ signInApi: ctx.signInApi, client: ctx.client });
        },
      },
      {
        id: "b",
        setup: (ctx) => {
          received.push({ signInApi: ctx.signInApi, client: ctx.client });
        },
      },
    ]);
    expect(received[0].signInApi).toBe(SIGN_IN_API);
    expect(received[1].signInApi).toBe(SIGN_IN_API);
    expect(received[0].client).toBe(client);
    expect(received[1].client).toBe(client);
  });
});
