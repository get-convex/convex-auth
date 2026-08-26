// @vitest-environment jsdom
import { act, renderHook, waitFor } from "@testing-library/react";
import { ConvexProvider, type ConvexReactClient } from "convex/react";
import { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import type { ListPasskeysResult } from "./list.ts";
import {
  type AddPasskeyResult,
  type PasskeyManagementApi,
  type RemovePasskeyResult,
  usePasskeyManagement,
} from "./react.tsx";

// The flows call several different functions and the tests assert their
// order, so every step of a flow records its name here.
const callOrder: string[] = [];

// The hook calls several different mutations, so the client dispatches on
// the reference (a string sentinel here) to one mock per mutation.
const mutations = {
  startAddPasskey: vi.fn(),
  verifyAddPasskey: vi.fn(),
  finishAddPasskey: vi.fn(),
  startRemovePasskey: vi.fn(),
  finishRemovePasskey: vi.fn(),
};
const runMutation = (fn: unknown, args: unknown) => {
  callOrder.push(fn as string);
  return mutations[fn as keyof typeof mutations](args);
};

// `useQuery` reads its value through `watchQuery` on the client, so the
// substituted client hands out a watch over this variable.
let listResult: ListPasskeysResult | undefined;
const listListeners = new Set<() => void>();

const convexClient = {
  mutation: runMutation,
  watchQuery: () => ({
    localQueryResult: () => listResult,
    onUpdate: (listener: () => void) => {
      listListeners.add(listener);
      return () => {
        listListeners.delete(listener);
      };
    },
    journal: () => undefined,
  }),
} as unknown as ConvexReactClient;

const managementApi = {
  listPasskeys: "listPasskeys",
  startAddPasskey: "startAddPasskey",
  verifyAddPasskey: "verifyAddPasskey",
  finishAddPasskey: "finishAddPasskey",
  startRemovePasskey: "startRemovePasskey",
  finishRemovePasskey: "finishRemovePasskey",
} as unknown as PasskeyManagementApi;

// The browser WebAuthn surface. jsdom has none, so the tests install a
// fake `PublicKeyCredential` and `navigator.credentials`.
const credentialsCreate = vi.fn();
const credentialsGet = vi.fn();

class FakePublicKeyCredential {}

const addStart = {
  success: true,
  challenge: new ArrayBuffer(16),
  allowCredentials: [{ id: new ArrayBuffer(8), transports: ["internal"] }],
  rpId: "localhost",
};

const addVerified = {
  success: true,
  challenge: new ArrayBuffer(16),
  userHandle: new ArrayBuffer(16),
  excludeCredentials: [{ id: new ArrayBuffer(8), transports: ["hybrid"] }],
  rpId: "localhost",
  rpName: "Test app",
  username: "alice",
};

const removeStart = {
  success: true,
  challenge: new ArrayBuffer(16),
  allowCredentials: [{ id: new ArrayBuffer(4), transports: ["usb"] }],
  rpId: "localhost",
};

// A stand-in for the credential `navigator.credentials.create()` returns.
const attestationCredential = {
  rawId: new ArrayBuffer(8),
  response: {
    attestationObject: new ArrayBuffer(1),
    clientDataJSON: new ArrayBuffer(2),
    getTransports: () => ["internal", "hybrid"],
  },
};

// A stand-in for the credential `navigator.credentials.get()` returns.
const assertionCredential = {
  rawId: new ArrayBuffer(8),
  response: {
    authenticatorData: new ArrayBuffer(1),
    clientDataJSON: new ArrayBuffer(2),
    signature: new ArrayBuffer(3),
  },
};

const assertionArgs = {
  credentialId: assertionCredential.rawId,
  authenticatorData: assertionCredential.response.authenticatorData,
  clientDataJSON: assertionCredential.response.clientDataJSON,
  signature: assertionCredential.response.signature,
};

// `vi.unstubAllGlobals()` does not undo `Object.defineProperty`, so the
// tests restore the original `navigator.credentials` own property (or its
// absence) themselves.
const originalCredentials = Object.getOwnPropertyDescriptor(
  window.navigator,
  "credentials",
);

beforeEach(() => {
  vi.stubGlobal("PublicKeyCredential", FakePublicKeyCredential);
  vi.stubGlobal("isSecureContext", true);
  Object.defineProperty(window.navigator, "credentials", {
    value: {
      create: (options: unknown) => {
        callOrder.push("create");
        return credentialsCreate(options);
      },
      get: (options: unknown) => {
        callOrder.push("get");
        return credentialsGet(options);
      },
    },
    configurable: true,
  });
});

afterEach(() => {
  if (originalCredentials === undefined) {
    delete (window.navigator as { credentials?: unknown }).credentials;
  } else {
    Object.defineProperty(window.navigator, "credentials", originalCredentials);
  }
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  for (const mock of Object.values(mutations)) {
    mock.mockReset();
  }
  credentialsCreate.mockReset();
  credentialsGet.mockReset();
  callOrder.length = 0;
  listResult = undefined;
  listListeners.clear();
});

function wrapper({ children }: { children: ReactNode }) {
  return <ConvexProvider client={convexClient}>{children}</ConvexProvider>;
}

function renderManagement() {
  return renderHook(
    // A new api object on every render, like Convex's generated `api`
    // proxy, whose property accesses never compare equal.
    () => usePasskeyManagement({ ...managementApi }),
    { wrapper },
  );
}

describe("usePasskeyManagement addPasskey", () => {
  test("runs both ceremonies and calls the five functions in order", async () => {
    mutations.startAddPasskey.mockResolvedValue(addStart);
    credentialsGet.mockResolvedValue(assertionCredential);
    mutations.verifyAddPasskey.mockResolvedValue(addVerified);
    credentialsCreate.mockResolvedValue(attestationCredential);
    mutations.finishAddPasskey.mockResolvedValue({
      success: true,
      passkeyId: "passkey-2",
    });
    const { result } = renderManagement();

    let returned!: AddPasskeyResult;
    await act(async () => {
      returned = await result.current.addPasskey();
    });

    expect(callOrder).toEqual([
      "startAddPasskey",
      "get",
      "verifyAddPasskey",
      "create",
      "finishAddPasskey",
    ]);
    const [request] = credentialsGet.mock.calls[0] as [
      { publicKey: PublicKeyCredentialRequestOptions },
    ];
    expect(request.publicKey.allowCredentials).toEqual([
      {
        type: "public-key",
        id: addStart.allowCredentials[0].id,
        transports: ["internal"],
      },
    ]);
    // `rawId` carries the credential ID bytes, not the base64url `id`.
    expect(mutations.verifyAddPasskey).toHaveBeenCalledWith(assertionArgs);

    const [creation] = credentialsCreate.mock.calls[0] as [
      { publicKey: PublicKeyCredentialCreationOptions },
    ];
    expect(creation.publicKey.excludeCredentials).toEqual([
      {
        type: "public-key",
        id: addVerified.excludeCredentials[0].id,
        transports: ["hybrid"],
      },
    ]);
    expect(creation.publicKey.user).toEqual({
      id: addVerified.userHandle,
      name: "alice",
      displayName: "alice",
    });
    expect(mutations.finishAddPasskey).toHaveBeenCalledWith({
      attestationObject: attestationCredential.response.attestationObject,
      clientDataJSON: attestationCredential.response.clientDataJSON,
      transports: ["internal", "hybrid"],
    });
    expect(returned).toEqual({ success: true, passkeyId: "passkey-2" });
  });

  test("an account without a username gets a plain display name", async () => {
    mutations.startAddPasskey.mockResolvedValue(addStart);
    credentialsGet.mockResolvedValue(assertionCredential);
    mutations.verifyAddPasskey.mockResolvedValue({
      ...addVerified,
      username: null,
    });
    credentialsCreate.mockResolvedValue(attestationCredential);
    mutations.finishAddPasskey.mockResolvedValue({
      success: true,
      passkeyId: "passkey-2",
    });
    const { result } = renderManagement();

    await act(async () => {
      await result.current.addPasskey();
    });

    const [creation] = credentialsCreate.mock.calls[0] as [
      { publicKey: PublicKeyCredentialCreationOptions },
    ];
    expect(creation.publicKey.user.name).toBe("user");
    expect(creation.publicKey.user.displayName).toBe("user");
  });

  test("a cancelled first dialog stops the flow before the verification", async () => {
    mutations.startAddPasskey.mockResolvedValue(addStart);
    credentialsGet.mockRejectedValue(
      new DOMException("The operation was cancelled.", "NotAllowedError"),
    );
    const { result } = renderManagement();

    let returned!: AddPasskeyResult;
    await act(async () => {
      returned = await result.current.addPasskey();
    });

    expect(returned).toEqual({
      success: false,
      userError: { error: "CEREMONY_ABORTED" },
    });
    expect(callOrder).toEqual(["startAddPasskey", "get"]);
    expect(result.current.pending).toBe(false);
  });

  test("a cancelled second dialog stops the flow after the verification", async () => {
    mutations.startAddPasskey.mockResolvedValue(addStart);
    credentialsGet.mockResolvedValue(assertionCredential);
    mutations.verifyAddPasskey.mockResolvedValue(addVerified);
    credentialsCreate.mockRejectedValue(
      new DOMException("The operation was cancelled.", "NotAllowedError"),
    );
    const { result } = renderManagement();

    let returned!: AddPasskeyResult;
    await act(async () => {
      returned = await result.current.addPasskey();
    });

    expect(returned).toEqual({
      success: false,
      userError: { error: "CEREMONY_ABORTED" },
    });
    // The re-authentication is spent and the registration challenge stays
    // unused until it expires. No passkey is added, thus the user simply
    // starts again.
    expect(mutations.finishAddPasskey).not.toHaveBeenCalled();
  });

  test("a null credential also folds into CEREMONY_ABORTED", async () => {
    mutations.startAddPasskey.mockResolvedValue(addStart);
    credentialsGet.mockResolvedValue(null);
    const { result } = renderManagement();

    let returned!: AddPasskeyResult;
    await act(async () => {
      returned = await result.current.addPasskey();
    });

    expect(returned).toEqual({
      success: false,
      userError: { error: "CEREMONY_ABORTED" },
    });
    expect(mutations.verifyAddPasskey).not.toHaveBeenCalled();
  });

  test("pending is true while the flow runs", async () => {
    mutations.startAddPasskey.mockResolvedValue(addStart);
    let resolveCeremony!: (value: unknown) => void;
    credentialsGet.mockReturnValue(
      new Promise((resolve) => {
        resolveCeremony = resolve;
      }),
    );
    mutations.verifyAddPasskey.mockResolvedValue(addVerified);
    credentialsCreate.mockResolvedValue(attestationCredential);
    mutations.finishAddPasskey.mockResolvedValue({
      success: true,
      passkeyId: "passkey-2",
    });
    const { result } = renderManagement();
    expect(result.current.pending).toBe(false);

    let flow!: Promise<AddPasskeyResult>;
    act(() => {
      flow = result.current.addPasskey();
    });
    await waitFor(() => expect(result.current.pending).toBe(true));

    // A second flow while one runs must not start another ceremony.
    let second!: RemovePasskeyResult;
    await act(async () => {
      second = await result.current.removePasskey("passkey-1");
    });
    expect(second).toEqual({
      success: false,
      userError: { error: "CEREMONY_ABORTED" },
    });
    expect(mutations.startRemovePasskey).not.toHaveBeenCalled();

    await act(async () => {
      resolveCeremony(assertionCredential);
      await flow;
    });
    expect(result.current.pending).toBe(false);
  });

  test("the callbacks keep one identity across re-renders", async () => {
    const { result, rerender } = renderManagement();
    const first = result.current;
    rerender();
    expect(result.current.addPasskey).toBe(first.addPasskey);
    expect(result.current.removePasskey).toBe(first.removePasskey);
  });
});

describe("usePasskeyManagement removePasskey", () => {
  test("runs the assertion and sends the target with it", async () => {
    mutations.startRemovePasskey.mockResolvedValue(removeStart);
    credentialsGet.mockResolvedValue(assertionCredential);
    mutations.finishRemovePasskey.mockResolvedValue({ success: true });
    const { result } = renderManagement();

    let returned!: RemovePasskeyResult;
    await act(async () => {
      returned = await result.current.removePasskey("passkey-1");
    });

    expect(callOrder).toEqual([
      "startRemovePasskey",
      "get",
      "finishRemovePasskey",
    ]);
    expect(mutations.startRemovePasskey).toHaveBeenCalledWith({
      passkeyId: "passkey-1",
    });
    const [request] = credentialsGet.mock.calls[0] as [
      { publicKey: PublicKeyCredentialRequestOptions },
    ];
    expect(request.publicKey.allowCredentials).toEqual([
      {
        type: "public-key",
        id: removeStart.allowCredentials[0].id,
        transports: ["usb"],
      },
    ]);
    expect(mutations.finishRemovePasskey).toHaveBeenCalledWith({
      passkeyId: "passkey-1",
      ...assertionArgs,
    });
    expect(returned).toEqual({ success: true });
  });

  test("a server userError passes through without a ceremony", async () => {
    const failure = { success: false, userError: { error: "LAST_PASSKEY" } };
    mutations.startRemovePasskey.mockResolvedValue(failure);
    const { result } = renderManagement();

    let returned!: RemovePasskeyResult;
    await act(async () => {
      returned = await result.current.removePasskey("passkey-1");
    });

    expect(returned).toEqual(failure);
    expect(credentialsGet).not.toHaveBeenCalled();
    expect(mutations.finishRemovePasskey).not.toHaveBeenCalled();
  });
});

describe("usePasskeyManagement passkeys", () => {
  test("stays undefined while the subscription loads", () => {
    const { result } = renderManagement();
    expect(result.current.passkeys).toBe(undefined);
    expect(result.current.listError).toBe(null);
  });

  test("unwraps the success arm of the query", () => {
    const storedPasskeys = [
      {
        passkeyId: "passkey-1",
        name: "MacBook",
        credentialId: new ArrayBuffer(8),
        createdAt: 1,
      },
    ];
    listResult = { success: true, passkeys: storedPasskeys };
    const { result } = renderManagement();

    expect(result.current.passkeys).toEqual(storedPasskeys);
    expect(result.current.listError).toBe(null);
  });

  test("reports a signed-out session through listError", () => {
    listResult = { success: false, userError: { error: "NOT_SIGNED_IN" } };
    const { result } = renderManagement();

    expect(result.current.passkeys).toBe(undefined);
    expect(result.current.listError).toEqual({ error: "NOT_SIGNED_IN" });
  });
});
