// @vitest-environment jsdom
import { act, renderHook, waitFor } from "@testing-library/react";
import { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { AuthClient } from "../../browser/sessionManager";
import { InMemoryStorage } from "../../browser/storage";
import type { TokenBundle } from "../../lib/types";
import type { AuthSignInApi } from "../../react/client";
import { AuthProvider, useAuth } from "../../react/client";
import { useAuthToken } from "../../react";
import { PasskeyApi, PasskeySignInResult, usePasskey } from "./react";

// The hook runs its mutations through the injected `AuthSignInApi`, so
// the tests substitute a signInApi rather than mocking `convex/react`. The
// passkey hook calls several different mutations, so this signInApi
// dispatches on the reference (a string sentinel here) to one mock per
// mutation.
const mutations = {
  startSignIn: vi.fn(),
  finishSignIn: vi.fn(),
  finishSignUp: vi.fn(),
  startAutofillSignIn: vi.fn(),
};
const signInApi = {
  mutation: (fn: unknown, args: unknown) =>
    mutations[fn as keyof typeof mutations](args),
} as unknown as AuthSignInApi;

const passkeyApi = {
  startSignIn: "startSignIn",
  startAutofillSignIn: "startAutofillSignIn",
  finishSignIn: "finishSignIn",
  finishSignUp: "finishSignUp",
} as unknown as PasskeyApi;

// The browser WebAuthn surface. jsdom has none, so the tests install a
// fake `PublicKeyCredential` and `navigator.credentials`.
const credentialsCreate = vi.fn();
const credentialsGet = vi.fn();

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
  excludeCredentials: [],
  rpId: "localhost",
  rpName: "Test app",
};

const authenticateStart = {
  success: true,
  step: "authenticate",
  challenge: new ArrayBuffer(16),
  allowCredentials: [new ArrayBuffer(8)],
  rpId: "localhost",
};

// A stand-in for the credential `navigator.credentials.create()` returns.
const attestationCredential = {
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

// A conditional-mediation request that stays pending, like a real browser
// request until the user picks a passkey. It respects the abort signal, so
// the hook's abort protocol (STOP/PAUSE/REFRESH) works against it.
function pendingUntilAborted({ signal }: { signal?: AbortSignal }) {
  return new Promise((_, reject) => {
    signal?.addEventListener("abort", () => reject(signal.reason), {
      once: true,
    });
  });
}

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
    value: { create: credentialsCreate, get: credentialsGet },
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
});

function makeWrapper() {
  const client = new AuthClient({
    mode: "spa",
    authApi: { refreshSession: async () => null, signOut: async () => {} },
    storage: new InMemoryStorage(),
    storageNamespace: NAMESPACE,
  });
  return ({ children }: { children: ReactNode }) => (
    <AuthProvider authClient={client} signInApi={signInApi}>
      {children}
    </AuthProvider>
  );
}

function renderPasskey(
  initialProps: { autofill: boolean } = { autofill: false },
) {
  return renderHook(
    ({ autofill }: { autofill: boolean }) => ({
      auth: useAuth(),
      token: useAuthToken(),
      // A new api object on every render, like Convex's generated `api`
      // proxy, whose property accesses never compare equal.
      passkey: usePasskey({ ...passkeyApi }, { autofill }),
    }),
    { wrapper: makeWrapper(), initialProps },
  );
}

describe("usePasskey signIn", () => {
  test("sign-up success runs the registration ceremony and adopts the session", async () => {
    mutations.startSignIn.mockResolvedValue(registerStart);
    credentialsCreate.mockResolvedValue(attestationCredential);
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
    });
    expect(returned).toEqual({ success: true, tokens: bundle, flow: "signUp" });
    expect(result.current.auth.isAuthenticated).toBe(true);
    expect(result.current.token).toBe("access-1");
  });

  test("sign-in success runs the authentication ceremony and adopts the session", async () => {
    mutations.startSignIn.mockResolvedValue(authenticateStart);
    credentialsGet.mockResolvedValue(assertionCredential);
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
    expect(credentialsCreate).not.toHaveBeenCalled();
    expect(credentialsGet).not.toHaveBeenCalled();
    expect(result.current.auth.isAuthenticated).toBe(false);
  });

  test("NotAllowedError folds into CEREMONY_ABORTED", async () => {
    mutations.startSignIn.mockResolvedValue(authenticateStart);
    credentialsGet.mockRejectedValue(
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
    credentialsGet.mockReturnValue(
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
      userError: { error: "CEREMONY_ABORTED" },
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
    rerender({ autofill: false });
    expect(result.current.passkey.signIn).toBe(firstIdentity);
  });
});

describe("usePasskey autofill", () => {
  test("autofill: false reports status 'idle' and available: false", async () => {
    const { result, rerender } = renderPasskey({ autofill: false });
    expect(result.current.passkey.autofill.status).toBe("idle");
    expect(result.current.passkey.autofill.available).toBe(false);
    rerender({ autofill: false });
    expect(result.current.passkey.autofill.status).toBe("idle");
    expect(result.current.passkey.autofill.available).toBe(false);
    expect(mutations.startAutofillSignIn).not.toHaveBeenCalled();
  });

  test("a rejecting availability check reports available: false and status 'stopped'", async () => {
    const spy = vi
      .spyOn(FakePublicKeyCredential, "isConditionalMediationAvailable")
      .mockRejectedValue(new Error("detection failed"));
    const { result, unmount } = renderPasskey({ autofill: true });
    await waitFor(() =>
      expect(result.current.passkey.autofill.status).toBe("stopped"),
    );
    expect(result.current.passkey.autofill.available).toBe(false);
    expect(mutations.startAutofillSignIn).not.toHaveBeenCalled();
    spy.mockRestore();

    unmount();
    await act(async () => {});
  });

  test("flipping autofill to false moves status from 'waiting' back to 'idle'", async () => {
    mutations.startAutofillSignIn.mockResolvedValue({
      challenge: new ArrayBuffer(16),
      rpId: "localhost",
    });
    credentialsGet.mockImplementation(pendingUntilAborted);
    const { result, rerender, unmount } = renderPasskey({ autofill: true });
    await waitFor(() =>
      expect(result.current.passkey.autofill.status).toBe("waiting"),
    );
    expect(result.current.passkey.autofill.available).toBe(true);

    rerender({ autofill: false });
    await waitFor(() =>
      expect(result.current.passkey.autofill.status).toBe("idle"),
    );

    // Let the aborted loop settle before the next test runs.
    unmount();
    await act(async () => {});
  });

  test("a picked passkey signs the user in: waiting → signedIn", async () => {
    mutations.startAutofillSignIn.mockResolvedValue({
      challenge: new ArrayBuffer(16),
      rpId: "localhost",
    });
    credentialsGet.mockResolvedValue(assertionCredential);
    mutations.finishSignIn.mockResolvedValue({
      success: true,
      tokens: bundle,
      username: "alice",
    });
    const { result, unmount } = renderPasskey({ autofill: true });

    await waitFor(() =>
      expect(result.current.passkey.autofill.status).toBe("signedIn"),
    );
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
    mutations.startAutofillSignIn.mockResolvedValue({
      challenge: new ArrayBuffer(16),
      rpId: "localhost",
    });
    credentialsGet.mockResolvedValue(assertionCredential);
    // The first assertion fails on the server; the loop retries with a
    // fresh challenge and the second one succeeds.
    mutations.finishSignIn
      .mockResolvedValueOnce({
        success: false,
        userError: { error: "VERIFICATION_FAILED" },
      })
      .mockResolvedValueOnce({
        success: true,
        tokens: bundle,
        username: "alice",
      });
    const { result, unmount } = renderPasskey({ autofill: true });

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
    mutations.startAutofillSignIn.mockResolvedValue({
      challenge: new ArrayBuffer(16),
      rpId: "localhost",
    });
    // The conditional (autofill) request stays pending until aborted; the
    // modal ceremony resolves. Record every abort of a conditional
    // request, so the test can see the PAUSE.
    const conditionalAborts: unknown[] = [];
    credentialsGet.mockImplementation(
      (options: { mediation?: string; signal?: AbortSignal }) => {
        if (options.mediation !== "conditional") {
          // The modal ceremony must never run while a conditional request
          // is pending; a real browser rejects it.
          expect(conditionalAborts.length).toBeGreaterThan(0);
          return Promise.resolve(assertionCredential);
        }
        return new Promise((_, reject) => {
          options.signal?.addEventListener(
            "abort",
            () => {
              conditionalAborts.push(options.signal!.reason);
              reject(options.signal!.reason);
            },
            { once: true },
          );
        });
      },
    );
    mutations.startSignIn.mockResolvedValue(authenticateStart);
    mutations.finishSignIn.mockResolvedValue({
      success: true,
      tokens: bundle,
      username: "alice",
    });
    const { result, unmount } = renderPasskey({ autofill: true });
    await waitFor(() =>
      expect(result.current.passkey.autofill.status).toBe("waiting"),
    );
    expect(mutations.startAutofillSignIn).toHaveBeenCalledTimes(1);

    let returned!: PasskeySignInResult;
    await act(async () => {
      returned = await result.current.passkey.signIn({ username: "alice" });
    });

    // The modal flow paused the autofill request before its ceremony...
    expect(conditionalAborts).toEqual(["PAUSE"]);
    expect(returned).toEqual({
      success: true,
      tokens: bundle,
      username: "alice",
      flow: "signIn",
    });
    // ...and resumed it afterwards: the loop asks for a fresh challenge
    // and a new conditional request starts.
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
