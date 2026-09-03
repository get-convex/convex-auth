// @vitest-environment jsdom
import { act, renderHook, waitFor } from "@testing-library/react";
import { ConvexProvider, type ConvexReactClient } from "convex/react";
import { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { AuthClient } from "../../browser/sessionManager.ts";
import { InMemoryStorage } from "../../browser/storage.ts";
import type { TokenBundle } from "../../lib/types.ts";
import type { AuthSignInApi } from "../../react/client.tsx";
import { AuthProvider, useAuth } from "../../react/client.tsx";
import { useAuthToken } from "../../react/index.tsx";
import { PasskeyApi, PasskeySignInResult, usePasskey } from "./react.tsx";
import { usePasskeyAutofill, usePasskeyCeremonySlot } from "./react_impl.tsx";

const noopAutofill = { pause: () => {}, resume: () => {} };

// The hook calls several different mutations, so both call paths dispatch on
// the reference (a string sentinel here) to one mock per mutation.
const mutations = {
  startSignIn: vi.fn(),
  finishSignIn: vi.fn(),
  finishSignUp: vi.fn(),
  startAutofillSignIn: vi.fn(),
};
const runMutation = (fn: unknown, args: unknown) =>
  mutations[fn as keyof typeof mutations](args);

// The two session-minting mutations run through the injected `AuthSignInApi`,
// which the tests substitute rather than mocking a transport.
const signInApi = { mutation: runMutation } as unknown as AuthSignInApi;

// The two challenge mutations run on the Convex client from `useConvex()`,
// which the tests stand in for with the same dispatcher.
const convexClient = { mutation: runMutation } as unknown as ConvexReactClient;

const passkeyApi = {
  startSignIn: "startSignIn",
  startAutofillSignIn: "startAutofillSignIn",
  finishSignIn: "finishSignIn",
  finishSignUp: "finishSignUp",
} as unknown as PasskeyApi;

//------------------------------------------------------------------------------
// The fake browser ceremonies
//------------------------------------------------------------------------------
//
// jsdom has no WebAuthn, so the tests stub `navigator.credentials`. The
// modal and the conditional ceremonies share one ceremony slot, the way the
// browser does: starting any ceremony displaces a pending one, which
// rejects with an `AbortError`. The tests own what each ceremony resolves
// with through `ceremonyCreate` / `ceremonyGet` / `conditionalGet`.

const ceremonyCreate = vi.fn();
const ceremonyGet = vi.fn();
// The conditional request has its own control: the hook drives it with an
// `AbortSignal` it owns, which the modal ceremonies do not take.
const conditionalGet = vi.fn();

// What a browser rejects an aborted ceremony with.
function abortError() {
  return new DOMException("Ceremony was aborted", "AbortError");
}

let abortPending: ((reason: DOMException) => void) | null = null;

function runInCeremonySlot<T>(run: () => Promise<T>): Promise<T> {
  abortPending?.(abortError());
  return new Promise<T>((resolve, reject) => {
    abortPending = reject;
    const mine = reject;
    run().then(
      (value) => {
        if (abortPending === mine) abortPending = null;
        resolve(value);
      },
      (cause) => {
        if (abortPending === mine) abortPending = null;
        reject(cause);
      },
    );
  });
}

/**
 * The fake `navigator.credentials`. Every ceremony goes through the slot,
 * and the conditional request honours the caller's signal: an
 * already-aborted one is refused on entry, which is the property the hook
 * relies on.
 */
function stubCredentials() {
  Object.defineProperty(globalThis.navigator, "credentials", {
    configurable: true,
    value: {
      create: (options: unknown) =>
        runInCeremonySlot(() => ceremonyCreate(options)),
      get: (options: { mediation?: string; signal?: AbortSignal }) =>
        options.mediation !== "conditional"
          ? runInCeremonySlot(() => ceremonyGet(options))
          : runInCeremonySlot(
              () =>
                new Promise((resolve, reject) => {
                  const signal = options.signal;
                  if (signal?.aborted) {
                    reject(abortError());
                    return;
                  }
                  signal?.addEventListener(
                    "abort",
                    () => reject(abortError()),
                    { once: true },
                  );
                  conditionalGet(options).then(resolve, reject);
                }),
            ),
    },
  });
}

/** A ceremony that stays pending until the slot aborts it, like a real
 * conditional-mediation request until the user picks a passkey. */
const pendingForever = () => new Promise<never>(() => {});

class FakePublicKeyCredential {
  static isConditionalMediationAvailable = async () => true;
}

const NAMESPACE = "https://happy-animal-123.convex.cloud";

const bundle: TokenBundle = {
  accessToken: "access-1",
  accessTokenExpiresAt: 0,
  refreshToken: "refresh-1",
  refreshTokenExpiresAt: 0,
  userId: "user-1",
};

const registerStart = {
  success: true,
  step: "register",
  challenge: new ArrayBuffer(16),
  userHandle: new ArrayBuffer(16),
  rpId: "localhost",
  rpName: "Test app",
};

const authenticateStart = {
  success: true,
  step: "authenticate",
  challenge: new ArrayBuffer(16),
  allowCredentials: [{ id: new ArrayBuffer(8), transports: ["internal"] }],
  rpId: "localhost",
};

// What an autofill start mutation returns for a conditional request.
const requestOptions = { challenge: new ArrayBuffer(16), rpId: "localhost" };

// A stand-in for the credential `navigator.credentials.create()` returns.
const attestationCredential = {
  rawId: new ArrayBuffer(8),
  response: {
    attestationObject: new ArrayBuffer(1),
    clientDataJSON: new ArrayBuffer(2),
    getTransports: () => ["internal", "hybrid"],
  },
};

// A stand-in for an older browser, whose attestation response has no
// `getTransports` method.
const attestationCredentialWithoutTransports = {
  rawId: new ArrayBuffer(8),
  response: {
    attestationObject: new ArrayBuffer(1),
    clientDataJSON: new ArrayBuffer(2),
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

beforeEach(() => {
  vi.stubGlobal("PublicKeyCredential", FakePublicKeyCredential);
  vi.stubGlobal("isSecureContext", true);
  stubCredentials();
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  for (const mock of Object.values(mutations)) {
    mock.mockReset();
  }
  ceremonyCreate.mockReset();
  ceremonyGet.mockReset();
  conditionalGet.mockReset();
  abortPending = null;
});

function makeWrapper() {
  const client = new AuthClient({
    mode: "spa",
    authApi: {
      refreshSession: async () => ({ kind: "noSession" as const }),
      signOut: async () => {},
    },
    storage: new InMemoryStorage(),
    storageNamespace: NAMESPACE,
  });
  return ({ children }: { children: ReactNode }) => (
    <AuthProvider authClient={client} signInApi={signInApi}>
      <ConvexProvider client={convexClient}>{children}</ConvexProvider>
    </AuthProvider>
  );
}

function renderPasskey() {
  return renderHook(
    () => ({
      auth: useAuth(),
      token: useAuthToken(),
      // A new api object on every render, like Convex's generated `api`
      // proxy, whose property accesses never compare equal.
      passkey: usePasskey({ ...passkeyApi }),
    }),
    { wrapper: makeWrapper() },
  );
}

describe("usePasskey signIn", () => {
  test("sign-up success runs the registration ceremony and adopts the session", async () => {
    mutations.startSignIn.mockResolvedValue(registerStart);
    ceremonyCreate.mockResolvedValue(attestationCredential);
    mutations.finishSignUp.mockResolvedValue({ success: true, tokens: bundle });
    const { result } = renderPasskey();
    await waitFor(() => expect(result.current.auth.isLoading).toBe(false));

    let returned!: PasskeySignInResult;
    await act(async () => {
      returned = await result.current.passkey.signIn({ username: "alice" });
    });

    expect(mutations.startSignIn).toHaveBeenCalledWith({ username: "alice" });
    expect(mutations.finishSignUp).toHaveBeenCalledWith({
      username: "alice",
      attestationObject: attestationCredential.response.attestationObject,
      clientDataJSON: attestationCredential.response.clientDataJSON,
      transports: ["internal", "hybrid"],
    });
    expect(returned).toEqual({ success: true, tokens: bundle, flow: "signUp" });
    expect(result.current.auth.isAuthenticated).toBe(true);
    expect(result.current.token).toBe("access-1");
  });

  test("sends no transports when the browser has no getTransports", async () => {
    mutations.startSignIn.mockResolvedValue(registerStart);
    ceremonyCreate.mockResolvedValue(attestationCredentialWithoutTransports);
    mutations.finishSignUp.mockResolvedValue({ success: true, tokens: bundle });
    const { result } = renderPasskey();
    await waitFor(() => expect(result.current.auth.isLoading).toBe(false));

    let returned!: PasskeySignInResult;
    await act(async () => {
      returned = await result.current.passkey.signIn({ username: "alice" });
    });

    expect(returned.success).toBe(true);
    const [args] = mutations.finishSignUp.mock.calls[0] as [
      { transports?: string[] },
    ];
    expect(args.transports).toBe(undefined);
  });

  test("sign-in success runs the authentication ceremony and adopts the session", async () => {
    mutations.startSignIn.mockResolvedValue(authenticateStart);
    ceremonyGet.mockResolvedValue(assertionCredential);
    mutations.finishSignIn.mockResolvedValue({
      success: true,
      tokens: bundle,
      username: "alice",
    });
    const { result } = renderPasskey();
    await waitFor(() => expect(result.current.auth.isLoading).toBe(false));

    let returned!: PasskeySignInResult;
    await act(async () => {
      returned = await result.current.passkey.signIn({ username: "alice" });
    });

    const [request] = ceremonyGet.mock.calls[0] as [
      { publicKey: PublicKeyCredentialRequestOptions },
    ];
    expect(request.publicKey.allowCredentials).toEqual([
      {
        type: "public-key",
        id: authenticateStart.allowCredentials[0].id,
        transports: ["internal"],
      },
    ]);
    // `rawId` carries the credential ID bytes, not the base64url `id`.
    expect(mutations.finishSignIn).toHaveBeenCalledWith({
      credentialId: assertionCredential.rawId,
      authenticatorData: assertionCredential.response.authenticatorData,
      clientDataJSON: assertionCredential.response.clientDataJSON,
      signature: assertionCredential.response.signature,
    });
    expect(returned).toEqual({
      success: true,
      tokens: bundle,
      username: "alice",
      flow: "signIn",
    });
    expect(result.current.auth.isAuthenticated).toBe(true);
  });

  test("a server userError passes through without a ceremony", async () => {
    const failure = {
      success: false,
      userError: { error: "USERNAME_INVALID" },
    };
    mutations.startSignIn.mockResolvedValue(failure);
    const { result } = renderPasskey();
    await waitFor(() => expect(result.current.auth.isLoading).toBe(false));

    let returned!: PasskeySignInResult;
    await act(async () => {
      returned = await result.current.passkey.signIn({ username: "no" });
    });

    expect(returned).toEqual(failure);
    expect(ceremonyCreate).not.toHaveBeenCalled();
    expect(ceremonyGet).not.toHaveBeenCalled();
    expect(result.current.auth.isAuthenticated).toBe(false);
  });

  test("NotAllowedError folds into CEREMONY_ABORTED", async () => {
    mutations.startSignIn.mockResolvedValue(authenticateStart);
    ceremonyGet.mockRejectedValue(
      new DOMException("The operation was cancelled.", "NotAllowedError"),
    );
    const { result } = renderPasskey();
    await waitFor(() => expect(result.current.auth.isLoading).toBe(false));

    let returned!: PasskeySignInResult;
    await act(async () => {
      returned = await result.current.passkey.signIn({ username: "alice" });
    });

    expect(returned).toEqual({
      success: false,
      userError: { error: "CEREMONY_ABORTED" },
    });
    expect(result.current.auth.isAuthenticated).toBe(false);
    expect(result.current.passkey.pending).toBe(false);
  });

  test("a second signIn while one runs fails fast and the first completes", async () => {
    mutations.startSignIn.mockResolvedValue(authenticateStart);
    let resolveCeremony!: (value: unknown) => void;
    ceremonyGet.mockReturnValue(
      new Promise((resolve) => {
        resolveCeremony = resolve;
      }),
    );
    mutations.finishSignIn.mockResolvedValue({
      success: true,
      tokens: bundle,
      username: "alice",
    });
    const { result } = renderPasskey();
    await waitFor(() => expect(result.current.auth.isLoading).toBe(false));

    let first!: Promise<PasskeySignInResult>;
    act(() => {
      first = result.current.passkey.signIn({ username: "alice" });
    });
    await waitFor(() => expect(result.current.passkey.pending).toBe(true));

    // The second call must not start another ceremony or deadlock; it
    // returns a folded failure immediately.
    let second!: PasskeySignInResult;
    await act(async () => {
      second = await result.current.passkey.signIn({ username: "alice" });
    });
    expect(second).toEqual({
      success: false,
      userError: { error: "ALREADY_PENDING" },
    });
    expect(mutations.startSignIn).toHaveBeenCalledTimes(1);

    // The first call still completes normally.
    let firstResult!: PasskeySignInResult;
    await act(async () => {
      resolveCeremony(assertionCredential);
      firstResult = await first;
    });
    expect(firstResult).toEqual({
      success: true,
      tokens: bundle,
      username: "alice",
      flow: "signIn",
    });
    expect(result.current.passkey.pending).toBe(false);
    expect(result.current.auth.isAuthenticated).toBe(true);
  });

  test("signIn keeps one identity across re-renders", async () => {
    const { result, rerender } = renderPasskey();
    await waitFor(() => expect(result.current.auth.isLoading).toBe(false));
    const firstIdentity = result.current.passkey.signIn;
    rerender();
    expect(result.current.passkey.signIn).toBe(firstIdentity);
  });

  test("signIn keeps one identity while the autofill status changes", async () => {
    mutations.startAutofillSignIn.mockResolvedValue(requestOptions);
    conditionalGet.mockImplementation(pendingForever);
    const { result, unmount } = renderPasskey();
    // Captured before the loop reports anything, so the assertion below
    // spans `available` null → true and `status` idle → waiting.
    const firstIdentity = result.current.passkey.signIn;

    await waitFor(() =>
      expect(result.current.passkey.autofill.status).toBe("waiting"),
    );
    expect(result.current.passkey.signIn).toBe(firstIdentity);

    unmount();
    await act(async () => {});
  });
});

describe("usePasskey autofill", () => {
  test("a rejecting availability check reports available: false and status 'stopped'", async () => {
    const spy = vi
      .spyOn(FakePublicKeyCredential, "isConditionalMediationAvailable")
      .mockRejectedValue(new Error("detection failed"));
    const { result, unmount } = renderPasskey();
    await waitFor(() =>
      expect(result.current.passkey.autofill.status).toBe("stopped"),
    );
    expect(result.current.passkey.autofill.available).toBe(false);
    expect(mutations.startAutofillSignIn).not.toHaveBeenCalled();
    spy.mockRestore();

    unmount();
    await act(async () => {});
  });

  test("a picked passkey signs the user in: waiting → signedIn", async () => {
    mutations.startAutofillSignIn.mockResolvedValue(requestOptions);
    conditionalGet.mockResolvedValue(assertionCredential);
    mutations.finishSignIn.mockResolvedValue({
      success: true,
      tokens: bundle,
      username: "alice",
    });
    const { result, unmount } = renderPasskey();

    await waitFor(() =>
      expect(result.current.passkey.autofill.status).toBe("signedIn"),
    );
    // The request is a conditional one, and it carries the hook's own
    // abort signal rather than one from the library's singleton.
    const call = conditionalGet.mock.calls[0][0];
    expect(call.mediation).toBe("conditional");
    expect(call.signal).toBeInstanceOf(AbortSignal);
    expect(call.publicKey.rpId).toBe(requestOptions.rpId);
    expect(mutations.finishSignIn).toHaveBeenCalledWith({
      credentialId: assertionCredential.rawId,
      authenticatorData: assertionCredential.response.authenticatorData,
      clientDataJSON: assertionCredential.response.clientDataJSON,
      signature: assertionCredential.response.signature,
    });
    expect(result.current.auth.isAuthenticated).toBe(true);
    expect(result.current.passkey.autofill.lastError).toBe(null);

    unmount();
    await act(async () => {});
  });

  test("a success after a failed assertion clears lastError", async () => {
    mutations.startAutofillSignIn.mockResolvedValue(requestOptions);
    conditionalGet.mockResolvedValue(assertionCredential);
    // The first assertion fails on the server; the loop retries with a
    // fresh challenge and the second one succeeds.
    mutations.finishSignIn
      .mockResolvedValueOnce({
        success: false,
        userError: { error: "CHALLENGE_EXPIRED" },
      })
      .mockResolvedValueOnce({
        success: true,
        tokens: bundle,
        username: "alice",
      });
    const { result, unmount } = renderPasskey();

    await waitFor(() =>
      expect(result.current.passkey.autofill.status).toBe("signedIn"),
    );
    expect(result.current.auth.isAuthenticated).toBe(true);
    // The failure of the first attempt must not stay visible after the
    // user is signed in.
    expect(result.current.passkey.autofill.lastError).toBe(null);

    unmount();
    await act(async () => {});
  });

  test("signIn pauses the pending autofill request and resumes it after", async () => {
    mutations.startAutofillSignIn.mockResolvedValue(requestOptions);
    // The conditional (autofill) request stays pending until aborted; the
    // modal ceremony resolves. A modal ceremony while a conditional
    // request is still pending would displace it (the slot enforces this),
    // and the pause must have aborted it before that.
    let conditionalSignal: AbortSignal | undefined;
    conditionalGet.mockImplementation((options: { signal: AbortSignal }) => {
      conditionalSignal = options.signal;
      return pendingForever();
    });
    ceremonyGet.mockImplementation(() => {
      // The pause aborted the conditional request before the modal
      // ceremony started. The signal latches, thus this holds whether the
      // pause landed while the request was pending or still starting.
      expect(conditionalSignal?.aborted).toBe(true);
      return Promise.resolve(assertionCredential);
    });
    mutations.startSignIn.mockResolvedValue(authenticateStart);
    mutations.finishSignIn.mockResolvedValue({
      success: true,
      tokens: bundle,
      username: "alice",
    });
    const { result, unmount } = renderPasskey();
    await waitFor(() =>
      expect(result.current.passkey.autofill.status).toBe("waiting"),
    );
    expect(mutations.startAutofillSignIn).toHaveBeenCalledTimes(1);

    let returned!: PasskeySignInResult;
    await act(async () => {
      returned = await result.current.passkey.signIn({ username: "alice" });
    });

    expect(returned).toEqual({
      success: true,
      tokens: bundle,
      username: "alice",
      flow: "signIn",
    });
    // The modal flow resumed the loop afterwards: it asks for a fresh
    // challenge and a new conditional request starts.
    await waitFor(() =>
      expect(mutations.startAutofillSignIn).toHaveBeenCalledTimes(2),
    );
    await waitFor(() =>
      expect(result.current.passkey.autofill.status).toBe("waiting"),
    );

    unmount();
    await act(async () => {});
  });
});

describe("usePasskeyCeremonySlot", () => {
  test("run returns the callback's result and tracks pending", async () => {
    const { result } = renderHook(() =>
      usePasskeyCeremonySlot({ autofill: noopAutofill }),
    );
    expect(result.current.pending).toBe(false);

    let resolveCeremony!: (value: string) => void;
    let running!: Promise<string | { success: false }>;
    act(() => {
      running = result.current.run(
        () =>
          new Promise<string>((resolve) => {
            resolveCeremony = resolve;
          }),
      );
    });
    await waitFor(() => expect(result.current.pending).toBe(true));

    let returned!: string | { success: false };
    await act(async () => {
      resolveCeremony("done");
      returned = await running;
    });
    expect(returned).toBe("done");
    expect(result.current.pending).toBe(false);
  });

  test("a second run while one is running fails fast", async () => {
    const { result } = renderHook(() =>
      usePasskeyCeremonySlot({ autofill: noopAutofill }),
    );

    let resolveCeremony!: (value: string) => void;
    act(() => {
      void result.current.run(
        () =>
          new Promise<string>((resolve) => {
            resolveCeremony = resolve;
          }),
      );
    });
    await waitFor(() => expect(result.current.pending).toBe(true));

    const second = vi.fn(async () => "second");
    let returned!: string | { success: false; userError: unknown };
    await act(async () => {
      returned = await result.current.run(second);
    });
    expect(returned).toEqual({
      success: false,
      userError: { error: "ALREADY_PENDING" },
    });
    expect(second).not.toHaveBeenCalled();

    await act(async () => {
      resolveCeremony("done");
    });
    expect(result.current.pending).toBe(false);
  });

  test("a thrown value folds into the failure shape", async () => {
    const { result } = renderHook(() =>
      usePasskeyCeremonySlot({ autofill: noopAutofill }),
    );
    const cause = new Error("boom");
    let returned!: never | { success: false; userError: unknown };
    await act(async () => {
      returned = await result.current.run(async () => {
        throw cause;
      });
    });
    expect(returned).toEqual({
      success: false,
      userError: { error: "OTHER_ERROR", cause },
    });
    expect(result.current.pending).toBe(false);
  });

  test("run pauses the autofill gates around the callback, also on a throw", async () => {
    const calls: string[] = [];
    const autofill = {
      pause: () => {
        calls.push("pause");
      },
      resume: () => {
        calls.push("resume");
      },
    };
    const { result } = renderHook(() => usePasskeyCeremonySlot({ autofill }));
    await act(async () => {
      await result.current.run(async () => {
        calls.push("ceremony");
        throw new Error("boom");
      });
    });
    expect(calls).toEqual(["pause", "ceremony", "resume"]);
  });
});

describe("usePasskeyAutofill", () => {
  test("hands the picked assertion to onAssertion and reports success", async () => {
    conditionalGet.mockResolvedValue(assertionCredential);
    const start = vi.fn(async () => requestOptions);
    const onAssertion = vi.fn(async () => ({ success: true as const }));
    const { result, unmount } = renderHook(() =>
      usePasskeyAutofill({ start, onAssertion }),
    );

    await waitFor(() => expect(result.current.status).toBe("signedIn"));
    expect(result.current.available).toBe(true);
    expect(result.current.lastError).toBe(null);
    expect(onAssertion).toHaveBeenCalledWith({
      credentialId: assertionCredential.rawId,
      authenticatorData: assertionCredential.response.authenticatorData,
      clientDataJSON: assertionCredential.response.clientDataJSON,
      signature: assertionCredential.response.signature,
    });

    unmount();
    await act(async () => {});
  });

  test("stops after three failed assertions in a row", async () => {
    conditionalGet.mockResolvedValue(assertionCredential);
    const start = vi.fn(async () => requestOptions);
    const flowError = { error: "VERIFICATION_FAILED" as const };
    const onAssertion = vi.fn(async () => ({
      success: false as const,
      userError: flowError,
    }));
    const { result, unmount } = renderHook(() =>
      usePasskeyAutofill({ start, onAssertion }),
    );

    await waitFor(() => expect(result.current.status).toBe("stopped"));
    // Each retry asks for a fresh challenge.
    expect(start).toHaveBeenCalledTimes(3);
    expect(onAssertion).toHaveBeenCalledTimes(3);
    expect(result.current.lastError).toBe(flowError);

    unmount();
    await act(async () => {});
  });

  test("a pause taken before the loop starts holds the first request", async () => {
    conditionalGet.mockImplementation(pendingForever);
    const start = vi.fn(async () => requestOptions);
    const onAssertion = vi.fn(async () => ({ success: true as const }));
    const { result, unmount } = renderHook(() =>
      usePasskeyAutofill({ start, onAssertion }),
    );

    // Pause right away, while feature detection is still in flight: the
    // loop must park before it mints its first challenge.
    act(() => {
      result.current.pause();
    });
    await act(async () => {});
    expect(start).not.toHaveBeenCalled();

    act(() => {
      result.current.resume();
    });
    await waitFor(() => expect(result.current.status).toBe("waiting"));
    expect(start).toHaveBeenCalledTimes(1);

    unmount();
    await act(async () => {});
  });

  test("a pause while the challenge is being minted holds the request", async () => {
    conditionalGet.mockImplementation(pendingForever);
    // The start mutation stays pending, which puts the loop in the state
    // that used to lose a pause: it has decided to start a request but has
    // not called the browser yet.
    let mintChallenge!: () => void;
    let mintCalls = 0;
    const start = vi.fn(() => {
      mintCalls += 1;
      if (mintCalls > 1) {
        // The round after the resume mints without ceremony.
        return Promise.resolve(requestOptions);
      }
      return new Promise<typeof requestOptions>((resolve) => {
        mintChallenge = () => resolve(requestOptions);
      });
    });
    const onAssertion = vi.fn(async () => ({ success: true as const }));
    const { result, unmount } = renderHook(() =>
      usePasskeyAutofill({ start, onAssertion }),
    );
    await waitFor(() => expect(start).toHaveBeenCalledTimes(1));

    // The pause lands first, then the challenge arrives. No request may
    // reach the browser: the loop would take the ceremony slot from
    // whoever the pause was making room for.
    act(() => {
      result.current.pause();
    });
    await act(async () => {
      mintChallenge();
    });
    expect(conditionalGet).not.toHaveBeenCalled();

    act(() => {
      result.current.resume();
    });
    await waitFor(() => expect(conditionalGet).toHaveBeenCalledTimes(1));

    unmount();
    await act(async () => {});
  });

  test("a ceremony that takes the slot without pausing stops the flow", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    conditionalGet.mockImplementation(pendingForever);
    const start = vi.fn(async () => requestOptions);
    const onAssertion = vi.fn(async () => ({ success: true as const }));
    const { result, unmount } = renderHook(() =>
      usePasskeyAutofill({ start, onAssertion }),
    );
    await waitFor(() => expect(result.current.status).toBe("waiting"));

    // A ceremony that skipped `pause()` takes the slot, which ends the
    // pending conditional request without this hook aborting it. The loop
    // must not start a new request: it would abort that ceremony right
    // back, and against a browser that refuses conditional requests it
    // would spin on the start mutation.
    act(() => {
      abortPending?.(abortError());
      abortPending = null;
    });
    await waitFor(() => expect(result.current.status).toBe("stopped"));
    expect(result.current.lastError).toEqual({ error: "CEREMONY_ABORTED" });
    expect(start).toHaveBeenCalledTimes(1);
    // The developer is told, because this is a misuse of the hook that
    // nothing else can report: the foreign ceremony itself succeeds.
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0][0]).toContain("autofill has stopped");

    unmount();
    await act(async () => {});
  });

  test("an autofill effect restart mid-ceremony keeps the pause", async () => {
    conditionalGet.mockImplementation(pendingForever);
    const start = vi.fn(async () => requestOptions);
    const onAssertion = vi.fn(async () => ({ success: true as const }));
    const { result, rerender, unmount } = renderHook(
      ({ enabled }: { enabled: boolean }) => {
        const autofill = usePasskeyAutofill({ start, onAssertion, enabled });
        const modal = usePasskeyCeremonySlot({ autofill });
        return { autofill, modal };
      },
      { initialProps: { enabled: true } },
    );
    await waitFor(() => expect(result.current.autofill.status).toBe("waiting"));

    let finishCeremony!: () => void;
    let running!: Promise<string | { success: false }>;
    act(() => {
      running = result.current.modal.run(
        () =>
          new Promise<string>((resolve) => {
            finishCeremony = () => resolve("done");
          }),
      );
    });
    await waitFor(() => expect(result.current.modal.pending).toBe(true));
    expect(start).toHaveBeenCalledTimes(1);

    // Restart the autofill effect while the modal ceremony is running. The
    // pause lives on the hook, so the restarted loop must stay parked
    // instead of starting a request that would displace the ceremony.
    rerender({ enabled: false });
    rerender({ enabled: true });
    await act(async () => {});
    expect(start).toHaveBeenCalledTimes(1);

    let returned!: string | { success: false };
    await act(async () => {
      finishCeremony();
      returned = await running;
    });
    expect(returned).toBe("done");
    expect(result.current.modal.pending).toBe(false);
    // The resume of the finished ceremony lets the restarted loop start a
    // fresh request.
    await waitFor(() => expect(result.current.autofill.status).toBe("waiting"));
    expect(start).toHaveBeenCalledTimes(2);

    unmount();
    await act(async () => {});
  });

  test("a modal ceremony that ends before its abort settles restarts the loop", async () => {
    conditionalGet.mockImplementation(pendingForever);
    const start = vi.fn(async () => requestOptions);
    const onAssertion = vi.fn(async () => ({ success: true as const }));
    const { result, unmount } = renderHook(() => {
      const autofill = usePasskeyAutofill({ start, onAssertion });
      const modal = usePasskeyCeremonySlot({ autofill });
      return { autofill, modal };
    });
    await waitFor(() => expect(result.current.autofill.status).toBe("waiting"));

    // The modal ceremony pauses the loop, aborting the pending request,
    // and is over before that abort settles. The loop then sees its own
    // abort with the pause already retracted: it must not read that as a
    // foreign ceremony that displaced it and park for good.
    let returned!: string | { success: false };
    await act(async () => {
      returned = await result.current.modal.run(async () => "done");
    });
    expect(returned).toBe("done");

    await waitFor(() => expect(result.current.autofill.status).toBe("waiting"));
    expect(start).toHaveBeenCalledTimes(2);

    unmount();
    await act(async () => {});
  });

  test("disabling the hook stops the pending request for good", async () => {
    conditionalGet.mockImplementation(pendingForever);
    const start = vi.fn(async () => requestOptions);
    const onAssertion = vi.fn(async () => ({ success: true as const }));
    const { result, rerender, unmount } = renderHook(
      ({ enabled }: { enabled: boolean }) =>
        usePasskeyAutofill({ start, onAssertion, enabled }),
      { initialProps: { enabled: true } },
    );

    await waitFor(() => expect(result.current.status).toBe("waiting"));
    rerender({ enabled: false });
    await waitFor(() => expect(result.current.status).toBe("idle"));
    expect(result.current.available).toBe(false);
    expect(onAssertion).not.toHaveBeenCalled();
    // The loop really exited: no fresh challenge is minted afterwards.
    await act(async () => {});
    expect(start).toHaveBeenCalledTimes(1);

    unmount();
    await act(async () => {});
  });
});
