// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import {
  assertionFromCredential,
  foldClientError,
  runAuthenticationCeremony,
  runRegistrationCeremony,
  supportsWebAuthn,
} from "./client.ts";

// The browser WebAuthn surface. jsdom has none, so the tests install a
// fake `PublicKeyCredential` and `navigator.credentials`.
const credentialsCreate = vi.fn();
const credentialsGet = vi.fn();

class FakePublicKeyCredential {}

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

const registrationOptions = {
  challenge: new ArrayBuffer(16),
  rpId: "localhost",
  rpName: "Test app",
  userHandle: new ArrayBuffer(16),
  userName: "alice",
  userDisplayName: "Alice",
  excludeCredentials: [{ id: new ArrayBuffer(4), transports: ["internal"] }],
};

const authenticationOptions = {
  challenge: new ArrayBuffer(16),
  rpId: "localhost",
  allowCredentials: [{ id: new ArrayBuffer(8) }],
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
  credentialsCreate.mockReset();
  credentialsGet.mockReset();
});

describe("supportsWebAuthn", () => {
  test("true with PublicKeyCredential in a secure context", () => {
    expect(supportsWebAuthn()).toBe(true);
  });

  test("false without PublicKeyCredential", () => {
    vi.stubGlobal("PublicKeyCredential", undefined);
    expect(supportsWebAuthn()).toBe(false);
  });

  test("false outside a secure context", () => {
    vi.stubGlobal("isSecureContext", false);
    expect(supportsWebAuthn()).toBe(false);
  });
});

describe("foldClientError", () => {
  test("NotAllowedError folds into CEREMONY_ABORTED", () => {
    expect(
      foldClientError(new DOMException("cancelled", "NotAllowedError")),
    ).toEqual({ error: "CEREMONY_ABORTED" });
  });

  test("AbortError folds into CEREMONY_ABORTED", () => {
    expect(foldClientError(new DOMException("aborted", "AbortError"))).toEqual({
      error: "CEREMONY_ABORTED",
    });
  });

  test("everything else folds into OTHER_ERROR with the cause", () => {
    const cause = new Error("network blip");
    expect(foldClientError(cause)).toEqual({ error: "OTHER_ERROR", cause });
  });
});

describe("runRegistrationCeremony", () => {
  test("maps the options onto the create() call and returns the attestation", async () => {
    credentialsCreate.mockResolvedValue(attestationCredential);

    const result = await runRegistrationCeremony(registrationOptions);

    expect(result).toEqual({
      success: true,
      attestation: {
        attestationObject: attestationCredential.response.attestationObject,
        clientDataJSON: attestationCredential.response.clientDataJSON,
        transports: ["internal", "hybrid"],
      },
    });
    expect(credentialsCreate).toHaveBeenCalledWith({
      signal: undefined,
      publicKey: {
        challenge: registrationOptions.challenge,
        rp: { id: "localhost", name: "Test app" },
        user: {
          id: registrationOptions.userHandle,
          name: "alice",
          displayName: "Alice",
        },
        pubKeyCredParams: [
          { type: "public-key", alg: -7 },
          { type: "public-key", alg: -257 },
        ],
        authenticatorSelection: {
          residentKey: "required",
          requireResidentKey: true,
          userVerification: "required",
        },
        attestation: "none",
        excludeCredentials: [
          {
            type: "public-key",
            id: registrationOptions.excludeCredentials[0].id,
            transports: ["internal"],
          },
        ],
      },
    });
  });

  test("a response without getTransports reports no transports", async () => {
    credentialsCreate.mockResolvedValue({
      rawId: attestationCredential.rawId,
      response: {
        attestationObject: attestationCredential.response.attestationObject,
        clientDataJSON: attestationCredential.response.clientDataJSON,
      },
    });
    const result = await runRegistrationCeremony(registrationOptions);
    expect(result).toEqual({
      success: true,
      attestation: {
        attestationObject: attestationCredential.response.attestationObject,
        clientDataJSON: attestationCredential.response.clientDataJSON,
        transports: undefined,
      },
    });
  });

  test("a null credential folds into CEREMONY_ABORTED", async () => {
    credentialsCreate.mockResolvedValue(null);
    expect(await runRegistrationCeremony(registrationOptions)).toEqual({
      success: false,
      userError: { error: "CEREMONY_ABORTED" },
    });
  });

  test("a thrown NotAllowedError folds into CEREMONY_ABORTED", async () => {
    credentialsCreate.mockRejectedValue(
      new DOMException("cancelled", "NotAllowedError"),
    );
    expect(await runRegistrationCeremony(registrationOptions)).toEqual({
      success: false,
      userError: { error: "CEREMONY_ABORTED" },
    });
  });

  test("an unexpected throw folds into OTHER_ERROR with the cause", async () => {
    const cause = new Error("boom");
    credentialsCreate.mockRejectedValue(cause);
    expect(await runRegistrationCeremony(registrationOptions)).toEqual({
      success: false,
      userError: { error: "OTHER_ERROR", cause },
    });
  });

  test("no WebAuthn support folds into WEBAUTHN_UNSUPPORTED", async () => {
    vi.stubGlobal("PublicKeyCredential", undefined);
    expect(await runRegistrationCeremony(registrationOptions)).toEqual({
      success: false,
      userError: { error: "WEBAUTHN_UNSUPPORTED" },
    });
    expect(credentialsCreate).not.toHaveBeenCalled();
  });
});

describe("runAuthenticationCeremony", () => {
  test("maps the options onto the get() call and returns the assertion", async () => {
    credentialsGet.mockResolvedValue(assertionCredential);

    const result = await runAuthenticationCeremony(authenticationOptions);

    expect(result).toEqual({
      success: true,
      assertion: {
        // `rawId` carries the credential ID bytes, not the base64url `id`.
        credentialId: assertionCredential.rawId,
        authenticatorData: assertionCredential.response.authenticatorData,
        clientDataJSON: assertionCredential.response.clientDataJSON,
        signature: assertionCredential.response.signature,
      },
    });
    expect(credentialsGet).toHaveBeenCalledWith({
      signal: undefined,
      publicKey: {
        challenge: authenticationOptions.challenge,
        rpId: "localhost",
        allowCredentials: [
          {
            type: "public-key",
            id: authenticationOptions.allowCredentials[0].id,
            transports: undefined,
          },
        ],
        userVerification: "required",
      },
    });
  });

  test("a null credential folds into CEREMONY_ABORTED", async () => {
    credentialsGet.mockResolvedValue(null);
    expect(await runAuthenticationCeremony(authenticationOptions)).toEqual({
      success: false,
      userError: { error: "CEREMONY_ABORTED" },
    });
  });

  test("an aborted signal folds into CEREMONY_ABORTED", async () => {
    credentialsGet.mockImplementation(({ signal }: { signal?: AbortSignal }) =>
      Promise.reject(
        signal?.aborted
          ? new DOMException("aborted", "AbortError")
          : new Error("expected an aborted signal"),
      ),
    );
    const controller = new AbortController();
    controller.abort();
    expect(
      await runAuthenticationCeremony({
        ...authenticationOptions,
        signal: controller.signal,
      }),
    ).toEqual({
      success: false,
      userError: { error: "CEREMONY_ABORTED" },
    });
  });

  test("no WebAuthn support folds into WEBAUTHN_UNSUPPORTED", async () => {
    vi.stubGlobal("PublicKeyCredential", undefined);
    expect(await runAuthenticationCeremony(authenticationOptions)).toEqual({
      success: false,
      userError: { error: "WEBAUTHN_UNSUPPORTED" },
    });
    expect(credentialsGet).not.toHaveBeenCalled();
  });
});

describe("assertionFromCredential", () => {
  test("uses rawId and the assertion response fields", () => {
    expect(
      assertionFromCredential(
        assertionCredential as unknown as PublicKeyCredential,
      ),
    ).toEqual({
      credentialId: assertionCredential.rawId,
      authenticatorData: assertionCredential.response.authenticatorData,
      clientDataJSON: assertionCredential.response.clientDataJSON,
      signature: assertionCredential.response.signature,
    });
  });
});
