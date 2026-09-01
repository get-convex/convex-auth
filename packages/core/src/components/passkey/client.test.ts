// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import {
  authenticate,
  authenticateWithAutofill,
  foldClientError,
  register,
  supportsWebAuthn,
} from "./client.ts";
import { fromBase64URL, toBase64URL } from "./base64url.ts";

// The ceremonies run through `navigator.credentials`, which jsdom has not.
// The tests stub it and check what the wrappers add on top: the support
// check, the decoding of the options, the encoding of the response, and
// the error fold.
const credentialsCreate = vi.fn();
const credentialsGet = vi.fn();

class FakePublicKeyCredential {}

const bytes = (text: string) =>
  Uint8Array.from(text, (character) => character.charCodeAt(0)).buffer;

/**
 * base64url of a short ASCII string. The ceremonies decode the options they
 * are given, so the fixtures have to be real base64url.
 */
const wire = (text: string) => toBase64URL(bytes(text));

// An attestation credential the way `navigator.credentials.create()`
// returns one.
const attestationCredential = {
  id: wire("credential-id"),
  rawId: bytes("credential-id"),
  response: {
    clientDataJSON: bytes("client-data"),
    attestationObject: bytes("attestation"),
    getTransports: () => ["internal", "hybrid"],
  },
  type: "public-key",
};

// An assertion credential the way `navigator.credentials.get()` returns
// one.
const assertionCredential = {
  id: wire("credential-id"),
  rawId: bytes("credential-id"),
  response: {
    clientDataJSON: bytes("client-data"),
    authenticatorData: bytes("auth-data"),
    signature: bytes("signature"),
    userHandle: bytes("user-handle"),
  },
  type: "public-key",
};

const creationOptions = {
  rp: { id: "localhost", name: "Test app" },
  user: { id: wire("handle"), name: "alice", displayName: "alice" },
  challenge: wire("challenge"),
  pubKeyCredParams: [{ alg: -7, type: "public-key" as const }],
  timeout: 600000,
  excludeCredentials: [],
  authenticatorSelection: {
    residentKey: "required" as const,
    requireResidentKey: true as const,
    userVerification: "required" as const,
  },
  attestation: "none" as const,
  extensions: {},
};

const requestOptions = {
  challenge: wire("challenge"),
  timeout: 600000,
  rpId: "localhost",
  allowCredentials: [],
  userVerification: "required" as const,
};

beforeEach(() => {
  vi.stubGlobal("PublicKeyCredential", FakePublicKeyCredential);
  vi.stubGlobal("isSecureContext", true);
  vi.stubGlobal("navigator", {
    credentials: { create: credentialsCreate, get: credentialsGet },
  });
});

afterEach(() => {
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

describe("register", () => {
  test("decodes the options for create() and encodes the response", async () => {
    credentialsCreate.mockResolvedValue(attestationCredential);

    const result = await register(creationOptions);

    // The wire carries base64url; the WebAuthn API takes bytes. Everything
    // else reaches the browser as the server built it.
    const [call] = credentialsCreate.mock.calls[0];
    expect(call.publicKey.challenge).toEqual(
      fromBase64URL(creationOptions.challenge),
    );
    expect(call.publicKey.user.id).toEqual(
      fromBase64URL(creationOptions.user.id),
    );
    expect(call.publicKey.rp).toEqual(creationOptions.rp);
    expect(call.publicKey.attestation).toBe("none");
    expect(call.publicKey.authenticatorSelection).toEqual(
      creationOptions.authenticatorSelection,
    );
    expect(result).toEqual({
      success: true,
      response: {
        id: wire("credential-id"),
        rawId: wire("credential-id"),
        response: {
          clientDataJSON: wire("client-data"),
          attestationObject: wire("attestation"),
          transports: ["internal", "hybrid"],
        },
        clientExtensionResults: {},
        type: "public-key",
      },
    });
  });

  test("a browser without getTransports reports no transports", async () => {
    credentialsCreate.mockResolvedValue({
      ...attestationCredential,
      response: {
        clientDataJSON: bytes("client-data"),
        attestationObject: bytes("attestation"),
      },
    });
    const result = await register(creationOptions);
    expect(result.success).toBe(true);
    expect(result.success && result.response.response).not.toHaveProperty(
      "transports",
    );
  });

  test("a null credential folds into CEREMONY_ABORTED", async () => {
    credentialsCreate.mockResolvedValue(null);
    expect(await register(creationOptions)).toEqual({
      success: false,
      userError: { error: "CEREMONY_ABORTED" },
    });
  });

  test("a thrown NotAllowedError folds into CEREMONY_ABORTED", async () => {
    credentialsCreate.mockRejectedValue(
      new DOMException("cancelled", "NotAllowedError"),
    );
    expect(await register(creationOptions)).toEqual({
      success: false,
      userError: { error: "CEREMONY_ABORTED" },
    });
  });

  test("an unexpected throw folds into OTHER_ERROR with the cause", async () => {
    const cause = new Error("boom");
    credentialsCreate.mockRejectedValue(cause);
    expect(await register(creationOptions)).toEqual({
      success: false,
      userError: { error: "OTHER_ERROR", cause },
    });
  });

  test("no WebAuthn support folds into WEBAUTHN_UNSUPPORTED", async () => {
    vi.stubGlobal("PublicKeyCredential", undefined);
    expect(await register(creationOptions)).toEqual({
      success: false,
      userError: { error: "WEBAUTHN_UNSUPPORTED" },
    });
    expect(credentialsCreate).not.toHaveBeenCalled();
  });
});

describe("authenticate", () => {
  test("decodes the options for get() and encodes the response", async () => {
    credentialsGet.mockResolvedValue(assertionCredential);

    const result = await authenticate({
      ...requestOptions,
      allowCredentials: [
        { id: wire("credential-id"), type: "public-key", transports: ["usb"] },
      ],
    });

    const [call] = credentialsGet.mock.calls[0];
    expect(call.publicKey.challenge).toEqual(
      fromBase64URL(requestOptions.challenge),
    );
    expect(call.publicKey.rpId).toBe(requestOptions.rpId);
    expect(call.publicKey.userVerification).toBe("required");
    expect(call.publicKey.allowCredentials).toEqual([
      {
        id: fromBase64URL(wire("credential-id")),
        type: "public-key",
        transports: ["usb"],
      },
    ]);
    expect(result).toEqual({
      success: true,
      response: {
        id: wire("credential-id"),
        rawId: wire("credential-id"),
        response: {
          clientDataJSON: wire("client-data"),
          authenticatorData: wire("auth-data"),
          signature: wire("signature"),
          userHandle: wire("user-handle"),
        },
        clientExtensionResults: {},
        type: "public-key",
      },
    });
  });

  test("an assertion without a user handle carries none", async () => {
    credentialsGet.mockResolvedValue({
      ...assertionCredential,
      response: {
        clientDataJSON: bytes("client-data"),
        authenticatorData: bytes("auth-data"),
        signature: bytes("signature"),
        userHandle: null,
      },
    });
    const result = await authenticate(requestOptions);
    expect(result.success).toBe(true);
    expect(result.success && result.response.response).not.toHaveProperty(
      "userHandle",
    );
  });

  test("a null credential folds into CEREMONY_ABORTED", async () => {
    credentialsGet.mockResolvedValue(null);
    expect(await authenticate(requestOptions)).toEqual({
      success: false,
      userError: { error: "CEREMONY_ABORTED" },
    });
  });

  test("an aborted ceremony folds into CEREMONY_ABORTED", async () => {
    credentialsGet.mockRejectedValue(new DOMException("aborted", "AbortError"));
    expect(await authenticate(requestOptions)).toEqual({
      success: false,
      userError: { error: "CEREMONY_ABORTED" },
    });
  });

  test("no WebAuthn support folds into WEBAUTHN_UNSUPPORTED", async () => {
    vi.stubGlobal("PublicKeyCredential", undefined);
    expect(await authenticate(requestOptions)).toEqual({
      success: false,
      userError: { error: "WEBAUTHN_UNSUPPORTED" },
    });
    expect(credentialsGet).not.toHaveBeenCalled();
  });
});

describe("authenticateWithAutofill", () => {
  // The conditional path calls `navigator.credentials.get` itself, so that
  // the caller can own the `AbortSignal`; see the comment on the function.
  const credentialsGet = vi.fn();

  function stubCredentials() {
    vi.stubGlobal("navigator", { credentials: { get: credentialsGet } });
  }

  /** A `PublicKeyCredential` the way the browser returns one. */
  function assertion({ userHandle }: { userHandle: ArrayBuffer | null }) {
    return {
      id: wire("credential-id"),
      rawId: fromBase64URL(wire("credential-id")),
      response: {
        clientDataJSON: fromBase64URL(wire("client-data")),
        authenticatorData: fromBase64URL(wire("auth-data")),
        signature: fromBase64URL(wire("signature")),
        userHandle,
      },
      type: "public-key",
    };
  }

  afterEach(() => {
    credentialsGet.mockReset();
  });

  test("asks for a conditional request with the caller's signal", async () => {
    stubCredentials();
    credentialsGet.mockResolvedValue(assertion({ userHandle: null }));
    const controller = new AbortController();

    await authenticateWithAutofill(requestOptions, controller.signal);

    expect(credentialsGet).toHaveBeenCalledTimes(1);
    const options = credentialsGet.mock.calls[0][0];
    expect(options.mediation).toBe("conditional");
    expect(options.signal).toBe(controller.signal);
    // Conditional mediation requires an empty allow-list.
    expect(options.publicKey.allowCredentials).toEqual([]);
    expect(options.publicKey.rpId).toBe(requestOptions.rpId);
    expect(options.publicKey.timeout).toBe(requestOptions.timeout);
    expect(options.publicKey.userVerification).toBe("required");
    expect(toBase64URL(options.publicKey.challenge)).toBe(
      requestOptions.challenge,
    );
  });

  test("puts the assertion into the wire shape", async () => {
    stubCredentials();
    credentialsGet.mockResolvedValue(
      assertion({ userHandle: fromBase64URL(wire("user-handle")) }),
    );

    expect(
      await authenticateWithAutofill(
        requestOptions,
        new AbortController().signal,
      ),
    ).toEqual({
      success: true,
      response: {
        id: wire("credential-id"),
        rawId: wire("credential-id"),
        response: {
          clientDataJSON: wire("client-data"),
          authenticatorData: wire("auth-data"),
          signature: wire("signature"),
          userHandle: wire("user-handle"),
        },
        clientExtensionResults: {},
        type: "public-key",
      },
    });
  });

  test("a discoverable assertion without a user handle carries none", async () => {
    stubCredentials();
    credentialsGet.mockResolvedValue(assertion({ userHandle: null }));

    const result = await authenticateWithAutofill(
      requestOptions,
      new AbortController().signal,
    );

    expect(result.success).toBe(true);
    expect(result.success && result.response.response).not.toHaveProperty(
      "userHandle",
    );
  });

  test("an abort folds into CEREMONY_ABORTED", async () => {
    stubCredentials();
    credentialsGet.mockRejectedValue(new DOMException("aborted", "AbortError"));

    expect(
      await authenticateWithAutofill(
        requestOptions,
        new AbortController().signal,
      ),
    ).toEqual({ success: false, userError: { error: "CEREMONY_ABORTED" } });
  });

  test("a null credential folds into CEREMONY_ABORTED", async () => {
    stubCredentials();
    credentialsGet.mockResolvedValue(null);

    expect(
      await authenticateWithAutofill(
        requestOptions,
        new AbortController().signal,
      ),
    ).toEqual({ success: false, userError: { error: "CEREMONY_ABORTED" } });
  });

  test("no WebAuthn support folds into WEBAUTHN_UNSUPPORTED", async () => {
    stubCredentials();
    vi.stubGlobal("PublicKeyCredential", undefined);

    expect(
      await authenticateWithAutofill(
        requestOptions,
        new AbortController().signal,
      ),
    ).toEqual({ success: false, userError: { error: "WEBAUTHN_UNSUPPORTED" } });
    expect(credentialsGet).not.toHaveBeenCalled();
  });
});
