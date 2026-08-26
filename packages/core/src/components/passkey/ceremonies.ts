/**
 * The browser side of the passkey provider: the WebAuthn ceremonies
 * (`navigator.credentials`) and the failures that only the client produces.
 *
 * The React hooks of the provider sit on this module. The sign-in hook
 * (`react.tsx`) and the management hook (`management/react.tsx`) run the
 * same two ceremonies, thus the ceremonies live here and neither hook
 * imports the other.
 *
 * @module
 */

import type { CredentialDescriptor } from "./validation.ts";

/**
 * Failures the client produces that the server never returns. The hooks
 * fold them into the result so callers handle *every* failure through the
 * one `userError` switch and never need their own `try`/`catch`:
 *
 * - `CEREMONY_ABORTED`: the user dismissed the passkey dialog, the browser
 *   refused the ceremony (`NotAllowedError`), or a second call came in
 *   while one was already running (the browser would refuse the second
 *   modal ceremony anyway). This is the most common failure; show a calm
 *   "the operation was cancelled" message.
 * - `WEBAUTHN_UNSUPPORTED`: the browser has no WebAuthn support, or the
 *   page is not a secure context.
 * - `OTHER_ERROR`: everything else thrown (a network blip, a bug, an
 *   unexpected server error). The thrown value is preserved on `cause` for
 *   callers that want to inspect or log it.
 */
export type ClientFailure = {
  success: false;
  userError:
    | { error: "CEREMONY_ABORTED" }
    | { error: "WEBAUTHN_UNSUPPORTED" }
    | { error: "OTHER_ERROR"; cause: unknown };
};

/** Tell whether this page can run a WebAuthn ceremony at all. */
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
  // allowed to run one. A `null` credential is handled separately.
  return cause instanceof DOMException && cause.name === "NotAllowedError";
}

/**
 * Fold a thrown value into the {@link ClientFailure} `userError` shape, so
 * callers handle every failure through the one `userError` switch.
 */
export function foldClientError(cause: unknown): ClientFailure["userError"] {
  if (isCeremonyAborted(cause)) {
    return { error: "CEREMONY_ABORTED" };
  }
  return { error: "OTHER_ERROR", cause };
}

/** The arguments a server function needs from a WebAuthn assertion. */
export type AssertionArgs = {
  credentialId: ArrayBuffer;
  authenticatorData: ArrayBuffer;
  clientDataJSON: ArrayBuffer;
  signature: ArrayBuffer;
};

/**
 * Turn an assertion credential into the arguments of the finishing
 * mutation. Shared between the modal paths and the autofill path.
 */
export function assertionArgs(credential: PublicKeyCredential): AssertionArgs {
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

/** The server data that a registration ceremony needs. */
export type RegistrationCeremonyStart = {
  challenge: ArrayBuffer;
  userHandle: ArrayBuffer;
  excludeCredentials: CredentialDescriptor[];
  rpId: string;
  rpName: string;
};

/** The arguments a registration ceremony produces for the server. */
export type RegistrationCeremonyArgs = {
  attestationObject: ArrayBuffer;
  clientDataJSON: ArrayBuffer;
  transports?: string[];
};

/**
 * Run the modal registration ceremony and return the arguments of the
 * finishing mutation, or `null` when the browser returns no credential.
 *
 * `displayName` becomes the WebAuthn `user.name` and `user.displayName`:
 * the text that the passkey manager shows next to the passkey.
 */
export async function runRegistrationCeremony(
  displayName: string,
  start: RegistrationCeremonyStart,
): Promise<RegistrationCeremonyArgs | null> {
  const credential = (await navigator.credentials.create({
    publicKey: {
      challenge: start.challenge,
      rp: { id: start.rpId, name: start.rpName },
      // The handle comes from the server: at sign-up the app user id
      // cannot be used, because the user row does not exist yet.
      user: {
        id: start.userHandle,
        name: displayName,
        displayName,
      },
      // Exactly the algorithms the server accepts (ES256 and RS256; see
      // the verification in `registration.ts`).
      pubKeyCredParams: [
        { type: "public-key", alg: -7 }, // ES256
        { type: "public-key", alg: -257 }, // RS256
      ],
      // A discoverable credential is required for autofill, and the
      // server hard-requires user verification.
      authenticatorSelection: {
        residentKey: "required",
        requireResidentKey: true,
        userVerification: "required",
      },
      attestation: "none",
      excludeCredentials: credentialDescriptors(start.excludeCredentials),
    },
  })) as PublicKeyCredential | null;
  if (credential === null) {
    return null;
  }
  const response = credential.response as AuthenticatorAttestationResponse;
  return {
    attestationObject: response.attestationObject,
    clientDataJSON: response.clientDataJSON,
    // Older browsers have no `getTransports`. Then the server stores no
    // transports for this credential.
    transports:
      typeof response.getTransports === "function"
        ? response.getTransports()
        : undefined,
  };
}

/** The server data that an authentication ceremony needs. */
export type AuthenticationCeremonyStart = {
  challenge: ArrayBuffer;
  allowCredentials: CredentialDescriptor[];
  rpId: string;
};

/**
 * Run the modal authentication ceremony and return the assertion
 * arguments, or `null` when the browser returns no credential.
 */
export async function runAuthenticationCeremony(
  start: AuthenticationCeremonyStart,
): Promise<AssertionArgs | null> {
  const credential = (await navigator.credentials.get({
    publicKey: {
      challenge: start.challenge,
      rpId: start.rpId,
      allowCredentials: credentialDescriptors(start.allowCredentials),
      userVerification: "required",
    },
  })) as PublicKeyCredential | null;
  if (credential === null) {
    return null;
  }
  return assertionArgs(credential);
}
