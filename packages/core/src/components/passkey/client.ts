/**
 * Framework-agnostic browser client for the passkey provider.
 *
 * This module is internal: the public surface of the provider is the React
 * hooks in `react.tsx`, which are built on it. The `exports` field of the
 * package blocks `providers/passkey/client`, so an app cannot import this
 * file. It becomes a public entry point only when a real non-React consumer
 * asks for one.
 *
 * These functions wrap the modal WebAuthn ceremonies
 * (`navigator.credentials`). They do not depend on React and they do not
 * call any Convex function: a flow starts a ceremony with data from its
 * start mutation, runs the ceremony here, and sends the result to its
 * finish mutation.
 *
 * The functions never throw. They return discriminated unions, and they
 * fold every failure into the {@link PasskeyClientError} shape, so callers
 * handle every failure through one `userError` switch and never need their
 * own `try`/`catch`.
 *
 * @internal
 * @module
 */

import type { CredentialDescriptor } from "./validation.ts";

/**
 * The failures the browser side produces (the server never returns these):
 *
 * - `CEREMONY_ABORTED`: the user dismissed the passkey dialog, the browser
 *   refused the ceremony (`NotAllowedError`), or the caller aborted it
 *   through an `AbortSignal`. This is the most common failure; show a calm
 *   "sign-in was cancelled" message.
 * - `WEBAUTHN_UNSUPPORTED`: the browser has no WebAuthn support, or the
 *   page is not a secure context.
 * - `OTHER_ERROR`: everything else thrown (a network blip, a bug, an
 *   unexpected server error). The thrown value is preserved on `cause` for
 *   callers that want to inspect or log it.
 */
export type PasskeyClientError =
  | { error: "CEREMONY_ABORTED" }
  | { error: "WEBAUTHN_UNSUPPORTED" }
  | { error: "OTHER_ERROR"; cause: unknown };

/**
 * The output of a registration ceremony: the fields a finish mutation needs
 * to verify the new passkey (see `finishSignUp` in the username + passkey
 * recipe).
 */
export type PasskeyAttestation = {
  attestationObject: ArrayBuffer;
  clientDataJSON: ArrayBuffer;
  // Older browsers have no `getTransports`. Then the server stores no
  // transports for this credential.
  transports?: string[];
};

/**
 * The output of an authentication ceremony: the fields a finish mutation
 * needs to verify the signature (see `finishSignIn` in the username +
 * passkey recipe).
 */
export type PasskeyAssertion = {
  credentialId: ArrayBuffer;
  authenticatorData: ArrayBuffer;
  clientDataJSON: ArrayBuffer;
  signature: ArrayBuffer;
};

/**
 * The result of {@link runRegistrationCeremony}: the attestation to send to
 * the finish mutation, or a user-facing `userError`.
 */
export type PasskeyRegistrationResult =
  | { success: true; attestation: PasskeyAttestation }
  | { success: false; userError: PasskeyClientError };

/**
 * The result of {@link runAuthenticationCeremony}: the assertion to send to
 * the finish mutation, or a user-facing `userError`.
 */
export type PasskeyAuthenticationResult =
  | { success: true; assertion: PasskeyAssertion }
  | { success: false; userError: PasskeyClientError };

/**
 * Whether this browser can run WebAuthn ceremonies on this page. The
 * ceremony functions run this check themselves; call it directly to hide a
 * passkey button up front.
 */
export function supportsWebAuthn(): boolean {
  return (
    typeof window !== "undefined" &&
    typeof PublicKeyCredential !== "undefined" &&
    window.isSecureContext
  );
}

function isCeremonyAborted(cause: unknown): boolean {
  // `NotAllowedError` is what the browser throws when the user dismisses
  // the dialog, when the ceremony times out, and when the page is not
  // allowed to run one. `AbortError` is what an `AbortSignal` produces.
  // A `null` credential is handled separately.
  return (
    cause instanceof DOMException &&
    (cause.name === "NotAllowedError" || cause.name === "AbortError")
  );
}

/**
 * Fold a thrown value into the {@link PasskeyClientError} shape, so callers
 * handle every failure through one `userError` switch. Useful for custom
 * flows that call `navigator.credentials` or a mutation themselves.
 */
export function foldClientError(cause: unknown): PasskeyClientError {
  if (isCeremonyAborted(cause)) {
    return { error: "CEREMONY_ABORTED" };
  }
  return { error: "OTHER_ERROR", cause };
}

/**
 * Turn the credential descriptors from the server into the WebAuthn shape
 * of `allowCredentials` and `excludeCredentials`.
 */
function credentialDescriptors(
  credentials: CredentialDescriptor[],
): PublicKeyCredentialDescriptor[] {
  return credentials.map(({ id, transports }) => ({
    type: "public-key",
    id,
    // The database stores a string array, we’re converting here
    // to the narrower DOM type ("internal" | "hybrid" | "usb" | "nfc" | … )
    transports: transports as AuthenticatorTransport[] | undefined,
  }));
}

/**
 * Turn an assertion credential from `navigator.credentials.get()` into a
 * {@link PasskeyAssertion}. Useful for custom flows that run the `get()`
 * call themselves, for example with conditional mediation.
 */
export function assertionFromCredential(
  credential: PublicKeyCredential,
): PasskeyAssertion {
  const response = credential.response as AuthenticatorAssertionResponse;
  return {
    // `rawId` carries the credential ID bytes; `credential.id` is the
    // base64url form and must not be sent.
    credentialId: credential.rawId,
    authenticatorData: response.authenticatorData,
    clientDataJSON: response.clientDataJSON,
    signature: response.signature,
  };
}

/**
 * Run a modal registration ceremony (`navigator.credentials.create()`).
 *
 * The `challenge`, `userHandle`, and `excludeCredentials` come from a start
 * mutation. The `userName` and `userDisplayName` are what the browser shows
 * for the new passkey in its passkey manager; the flow chooses them (for
 * example, the username the user typed).
 *
 * The created passkey is discoverable (required for autofill) and requires
 * user verification, which is what the server-side verification demands.
 *
 * @param options.signal Abort the ceremony (folds into `CEREMONY_ABORTED`).
 */
export async function runRegistrationCeremony(options: {
  challenge: ArrayBuffer;
  rpId: string;
  rpName: string;
  userHandle: ArrayBuffer;
  userName: string;
  userDisplayName: string;
  excludeCredentials: CredentialDescriptor[];
  signal?: AbortSignal;
}): Promise<PasskeyRegistrationResult> {
  if (!supportsWebAuthn()) {
    return { success: false, userError: { error: "WEBAUTHN_UNSUPPORTED" } };
  }
  try {
    const credential = (await navigator.credentials.create({
      signal: options.signal,
      publicKey: {
        challenge: options.challenge,
        rp: { id: options.rpId, name: options.rpName },
        user: {
          id: options.userHandle,
          name: options.userName,
          displayName: options.userDisplayName,
        },
        // Exactly the algorithms the server accepts (ES256 and RS256; see
        // the verification in `registration.ts`).
        pubKeyCredParams: [
          { type: "public-key", alg: -7 }, // ES256
          { type: "public-key", alg: -257 }, // RS256
        ],
        authenticatorSelection: {
          residentKey: "required",
          requireResidentKey: true,
          userVerification: "required",
        },
        attestation: "none",
        excludeCredentials: credentialDescriptors(options.excludeCredentials),
      },
    })) as PublicKeyCredential | null;
    if (credential === null) {
      return { success: false, userError: { error: "CEREMONY_ABORTED" } };
    }
    const response = credential.response as AuthenticatorAttestationResponse;
    return {
      success: true,
      attestation: {
        attestationObject: response.attestationObject,
        clientDataJSON: response.clientDataJSON,
        // Older browsers have no `getTransports`. Then the server stores
        // no transports for this credential.
        transports:
          typeof response.getTransports === "function"
            ? response.getTransports()
            : undefined,
      },
    };
  } catch (cause) {
    return { success: false, userError: foldClientError(cause) };
  }
}

/**
 * Run a modal authentication ceremony (`navigator.credentials.get()`).
 *
 * The `challenge` and `allowCredentials` come from a start mutation. An
 * empty `allowCredentials` lets the user pick any passkey of this relying
 * party; the picked passkey then identifies the account.
 *
 * @param options.signal Abort the ceremony (folds into `CEREMONY_ABORTED`).
 */
export async function runAuthenticationCeremony(options: {
  challenge: ArrayBuffer;
  rpId: string;
  allowCredentials: CredentialDescriptor[];
  signal?: AbortSignal;
}): Promise<PasskeyAuthenticationResult> {
  if (!supportsWebAuthn()) {
    return { success: false, userError: { error: "WEBAUTHN_UNSUPPORTED" } };
  }
  try {
    const credential = (await navigator.credentials.get({
      signal: options.signal,
      publicKey: {
        challenge: options.challenge,
        rpId: options.rpId,
        allowCredentials: credentialDescriptors(options.allowCredentials),
        userVerification: "required",
      },
    })) as PublicKeyCredential | null;
    if (credential === null) {
      return { success: false, userError: { error: "CEREMONY_ABORTED" } };
    }
    return { success: true, assertion: assertionFromCredential(credential) };
  } catch (cause) {
    return { success: false, userError: foldClientError(cause) };
  }
}
