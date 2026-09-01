/**
 * Framework-agnostic browser client for the passkey provider.
 *
 * This module is internal: the public surface of the provider is the React
 * hooks in `react.tsx`, which are built on it. The `exports` field of the
 * package blocks `providers/passkey/client`, so an app cannot import this
 * file. It becomes a public entry point only when a real non-React consumer
 * asks for one.
 *
 * These functions wrap the WebAuthn ceremonies (`navigator.credentials`),
 * modal and conditional. They do not depend on React and they do not call
 * any Convex function: a flow starts a ceremony with data from its start
 * mutation, runs the ceremony here, and sends the result to its finish
 * mutation.
 *
 * The functions never throw. They return discriminated unions, and they
 * fold every failure into the {@link PasskeyClientError} shape, so callers
 * handle every failure through one `userError` switch and never need their
 * own `try`/`catch`.
 *
 * @internal
 * @module
 */

import type {
  WireAuthenticationResponse,
  WireCreationOptions,
  WireRegistrationResponse,
  WireRequestOptions,
} from "./validation.ts";
import { fromBase64URL, toBase64URL } from "./base64url.ts";

// Apps and custom flows read the wire shapes from here: they are the exact
// shapes of the provider's mutations.
export type {
  WireAuthenticationResponse,
  WireCreationOptions,
  WireRegistrationResponse,
  WireRequestOptions,
} from "./validation.ts";

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
 * A failed result with a browser-side `userError`. The failure arm all the
 * ceremony functions and hooks share; it composes with the server's own
 * `{ success: false, userError }` results into one `userError` switch.
 */
export type PasskeyClientFailure = {
  success: false;
  userError: PasskeyClientError;
};

/**
 * The result of {@link register}: the response to send to the finish
 * mutation, or a user-facing `userError`.
 */
export type PasskeyRegistrationResult =
  { success: true; response: WireRegistrationResponse } | PasskeyClientFailure;

/**
 * The result of {@link authenticate}: the response to send to the finish
 * mutation, or a user-facing `userError`.
 */
export type PasskeyAuthenticationResult =
  | { success: true; response: WireAuthenticationResponse }
  | PasskeyClientFailure;

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

/**
 * Fold a thrown value into the {@link PasskeyClientError} shape, so callers
 * handle every failure through one `userError` switch. Useful for custom
 * flows that call `navigator.credentials` or a mutation themselves.
 */
export function foldClientError(cause: unknown): PasskeyClientError {
  // `NotAllowedError` is what the browser throws when the user dismisses
  // the dialog, when the ceremony times out, and when the page is not
  // allowed to run one. `AbortError` is what an `AbortSignal` produces.
  // A `null` credential is handled separately.
  if (
    cause instanceof DOMException &&
    (cause.name === "NotAllowedError" || cause.name === "AbortError")
  ) {
    return { error: "CEREMONY_ABORTED" };
  }
  return { error: "OTHER_ERROR", cause };
}

/**
 * Turn the JSON credential descriptors of the wire into the DOM shape of
 * `allowCredentials` and `excludeCredentials`.
 */
function descriptorsFromJSON(
  descriptors: WireRequestOptions["allowCredentials"],
): PublicKeyCredentialDescriptor[] {
  return descriptors.map(({ id, type, transports }) => ({
    id: fromBase64URL(id),
    type,
    // The wire keeps `transports` as free-form strings, because the
    // WebAuthn spec lets new transports appear; the DOM type does not.
    transports: transports as AuthenticatorTransport[] | undefined,
  }));
}

/**
 * Turn the creation options of the wire into the DOM shape that
 * `navigator.credentials.create()` takes: every binary field is base64url
 * on the wire and a `BufferSource` in the API.
 */
function creationOptionsFromJSON(
  options: WireCreationOptions,
): PublicKeyCredentialCreationOptions {
  return {
    rp: options.rp,
    user: {
      id: fromBase64URL(options.user.id),
      name: options.user.name,
      displayName: options.user.displayName,
    },
    challenge: fromBase64URL(options.challenge),
    pubKeyCredParams: options.pubKeyCredParams,
    timeout: options.timeout,
    excludeCredentials: descriptorsFromJSON(options.excludeCredentials),
    authenticatorSelection: options.authenticatorSelection,
    attestation: options.attestation,
    extensions: options.extensions,
  };
}

/** Turn the request options of the wire into the DOM shape that
 * `navigator.credentials.get()` takes (see
 * {@link creationOptionsFromJSON}). */
function requestOptionsFromJSON(
  options: WireRequestOptions,
): PublicKeyCredentialRequestOptions {
  return {
    challenge: fromBase64URL(options.challenge),
    timeout: options.timeout,
    rpId: options.rpId,
    allowCredentials: descriptorsFromJSON(options.allowCredentials),
    userVerification: options.userVerification,
  };
}

/**
 * Put an attestation credential from a `create()` call into the wire
 * shape.
 */
function attestationToJSON(
  credential: PublicKeyCredential,
): WireRegistrationResponse {
  const response = credential.response as AuthenticatorAttestationResponse;
  // Older browsers have no `getTransports`. Then the server stores no
  // transports for this credential.
  const transports =
    typeof response.getTransports === "function"
      ? response.getTransports()
      : undefined;
  return {
    id: credential.id,
    rawId: toBase64URL(credential.rawId),
    response: {
      clientDataJSON: toBase64URL(response.clientDataJSON),
      attestationObject: toBase64URL(response.attestationObject),
      ...(transports !== undefined ? { transports } : {}),
    },
    // The options request no extensions, so there is nothing to report.
    clientExtensionResults: {},
    type: "public-key",
  };
}

/**
 * Run a modal registration ceremony (a WebAuthn `create()` call).
 *
 * `options` comes from a start mutation, ready for the browser: this
 * function only decodes its binary fields.
 */
export async function register(
  options: WireCreationOptions,
): Promise<PasskeyRegistrationResult> {
  if (!supportsWebAuthn()) {
    return { success: false, userError: { error: "WEBAUTHN_UNSUPPORTED" } };
  }
  try {
    const credential = (await navigator.credentials.create({
      publicKey: creationOptionsFromJSON(options),
    })) as PublicKeyCredential | null; // navigator.credentials.get is typed as returning `Credential | null`, but with these arguments it returns a PublicKeyCredential
    if (credential === null) {
      return { success: false, userError: { error: "CEREMONY_ABORTED" } };
    }
    return { success: true, response: attestationToJSON(credential) };
  } catch (cause) {
    return { success: false, userError: foldClientError(cause) };
  }
}

/**
 * Run a modal authentication ceremony (a WebAuthn `get()` call).
 *
 * `options` comes from a start mutation, ready for the browser: this
 * function only decodes its binary fields.
 *
 * For the conditional-mediation flow, which stays pending until the user
 * picks a passkey in the autocompletion list of an
 * `<input autoComplete="… webauthn">`, use
 * {@link authenticateWithAutofill}.
 */
export async function authenticate(
  options: WireRequestOptions,
): Promise<PasskeyAuthenticationResult> {
  if (!supportsWebAuthn()) {
    return { success: false, userError: { error: "WEBAUTHN_UNSUPPORTED" } };
  }
  try {
    const credential = (await navigator.credentials.get({
      publicKey: requestOptionsFromJSON(options),
    })) as PublicKeyCredential | null; // navigator.credentials.get is typed as returning `Credential | null`, but with these arguments it returns a PublicKeyCredential
    if (credential === null) {
      return { success: false, userError: { error: "CEREMONY_ABORTED" } };
    }
    return { success: true, response: assertionToJSON(credential) };
  } catch (cause) {
    return { success: false, userError: foldClientError(cause) };
  }
}

/**
 * Run a conditional-mediation ceremony: the request stays pending until the
 * user picks a passkey in the autocompletion list of an
 * `<input autoComplete="… webauthn">`.
 *
 * `signal` aborts it. This is required because the caller is expected to
 * periodically recreate a new ceremony (because every ceremony has a timeout).
 */
export async function authenticateWithAutofill(
  options: WireRequestOptions,
  signal: AbortSignal,
): Promise<PasskeyAuthenticationResult> {
  if (!supportsWebAuthn()) {
    return { success: false, userError: { error: "WEBAUTHN_UNSUPPORTED" } };
  }
  try {
    const credential = await navigator.credentials.get({
      mediation: "conditional",
      signal,
      publicKey: {
        challenge: fromBase64URL(options.challenge),
        timeout: options.timeout,
        rpId: options.rpId,
        // Conditional mediation requires an empty allow-list: the passkey
        // the user picks in the autocompletion list identifies the account.
        allowCredentials: [],
        userVerification: options.userVerification,
      },
    });
    if (credential === null) {
      // The spec lets `get()` resolve with `null`. No assertion means no
      // ceremony, which is the same outcome for a caller as an abort.
      return { success: false, userError: { error: "CEREMONY_ABORTED" } };
    }
    return {
      success: true,
      response: assertionToJSON(credential as PublicKeyCredential),
    };
  } catch (cause) {
    return { success: false, userError: foldClientError(cause) };
  }
}

/**
 * Put an assertion credential from a `get()` call into the wire shape.
 */
function assertionToJSON(
  credential: PublicKeyCredential,
): WireAuthenticationResponse {
  const response = credential.response as AuthenticatorAssertionResponse;
  return {
    id: credential.id,
    rawId: toBase64URL(credential.rawId),
    response: {
      clientDataJSON: toBase64URL(response.clientDataJSON),
      authenticatorData: toBase64URL(response.authenticatorData),
      signature: toBase64URL(response.signature),
      ...(response.userHandle !== null
        ? { userHandle: toBase64URL(response.userHandle) }
        : {}),
    },
    clientExtensionResults: {},
    type: "public-key",
  };
}
