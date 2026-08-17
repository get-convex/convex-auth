// @vitest-environment jsdom
import { act, renderHook } from "@testing-library/react";
import { ReactNode } from "react";
import { describe, expect, test } from "vitest";
import type { ScopedKeyedStore } from "../browser/keyedStore";
import { AuthClient } from "../browser/sessionManager";
import { InMemoryStorage } from "../browser/storage";
import { AuthProvider } from "./client";
import { useAuthClientValue } from "./providers";
import { stubSignInApi } from "./testSignInApi";

const NAMESPACE = "https://happy-animal-123.convex.cloud";

function makeClient() {
  return new AuthClient({
    mode: "spa",
    authApi: { refreshSession: async () => null, signOut: async () => {} },
    storage: new InMemoryStorage(),
    storageNamespace: NAMESPACE,
  });
}

/**
 * An {@link AuthClient} with a probe provider client registered, plus the
 * scoped store its setup received so tests can write through it.
 */
function makeProbeClient() {
  const probe: { store?: ScopedKeyedStore } = {};
  const client = new AuthClient({
    mode: "spa",
    authApi: { refreshSession: async () => null, signOut: async () => {} },
    storage: new InMemoryStorage(),
    storageNamespace: NAMESPACE,
    providerClients: {
      setups: [
        {
          id: "probe",
          setup: (ctx) => {
            probe.store = ctx.store;
          },
        },
      ],
      signInApi: stubSignInApi().signInApi,
    },
  });
  if (probe.store === undefined) {
    throw new Error("probe setup did not run");
  }
  return { client, probeStore: probe.store };
}

function wrapperFor(client: AuthClient) {
  return ({ children }: { children: ReactNode }) => (
    <AuthProvider authClient={client} signInApi={stubSignInApi().signInApi}>
      {children}
    </AuthProvider>
  );
}

describe("useAuthClientValue", () => {
  test("throws when used outside a provider", () => {
    expect(() =>
      renderHook(() => useAuthClientValue("probe", "greeting")),
    ).toThrow(/useAuthClientValue must be used within a <ConvexAuthProvider>/);
  });

  test("returns undefined for an unregistered key", () => {
    const client = makeClient();
    const { result } = renderHook(
      () => useAuthClientValue("probe", "missing"),
      {
        wrapper: wrapperFor(client),
      },
    );
    expect(result.current).toBeUndefined();
  });

  test("reads a value seeded before render and re-renders on set", () => {
    const { client, probeStore } = makeProbeClient();
    probeStore.set("greeting", "hello");

    const { result } = renderHook(
      () => useAuthClientValue<string>("probe", "greeting"),
      { wrapper: wrapperFor(client) },
    );
    expect(result.current).toBe("hello");

    act(() => {
      probeStore.set("greeting", "hi again");
    });
    expect(result.current).toBe("hi again");
  });
});
