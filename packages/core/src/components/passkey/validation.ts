import { Infer, v } from "convex/values";

// How long a stored challenge stays valid. The WebAuthn spec recommends
// ceremony timeouts of 5–10 minutes to leave room for user interaction
// (PIN entry, cross-device flows); we match the upper bound. Expiring
// challenges bounds the window for replay of an intercepted challenge.
// https://www.w3.org/TR/webauthn-3/#sctn-timeout-recommended-range
export const CHALLENGE_TTL_MS = 10 * 60 * 1000; // 10 minutes

/**
 * Constants used for some basic best-effort validation of the
 * `transports` strings. These limits are far above the registered
 * values. They stop a client that does not obey the spec from writing
 * large data to the database.
 *
 * The WebAuthn spec gives no limit for these values, but each registered
 * transport is a short word of lowercase letters and hyphens ("usb",
 * "hybrid", "smart-card").
 */
const MAX_TRANSPORTS = 16;
const MAX_TRANSPORT_LENGTH = 32;

// The characters that a transport can contain: printable ASCII without
// the space.
const TRANSPORT_PATTERN = /^[\x21-\x7e]+$/;

/**
 * Examine the transports that the client reports, before the component
 * stores them.
 *
 * The component does not compare the values with a list of known
 * transports, because the WebAuthn spec lets new transports appear. It
 * only refuses the values that no authenticator can report.
 */
export function transportsAreValid(values: string[] | undefined): boolean {
  if (values === undefined) return true;

  if (values.length > MAX_TRANSPORTS) return false;

  return values.every(
    (value) =>
      value.length <= MAX_TRANSPORT_LENGTH && TRANSPORT_PATTERN.test(value),
  );
}

/**
 * One entry of `allowCredentials` or `excludeCredentials`. The WebAuthn
 * `type` field is not included, because it is always "public-key".
 */
export const credentialDescriptor = v.object({
  id: v.bytes(),
  transports: v.optional(v.array(v.string())),
});
export type CredentialDescriptor = Infer<typeof credentialDescriptor>;

/**
 * The client broke the WebAuthn protocol: an unexpected origin, an
 * attestation that no parser can read, a key algorithm that the ceremony
 * never offered, an assertion that no compliant authenticator makes, and so
 * on.
 *
 * This is the HTTP 400 of the component. Most of the time the client is at
 * fault, but the same code also covers a configuration mistake of the app
 * (an `rpId` or an `origin` that does not match the page). The two are not
 * separated, exactly as a 400 does not say whether the caller wrote a bad
 * request or configured a bad base URL.
 *
 * The end user cannot correct this, so an app shows a generic message. The
 * component writes which check failed to the backend logs, and never sends
 * the details to the client.
 */
const protocolError = v.object({ error: v.literal("PROTOCOL_ERROR") });

/**
 * The user-facing errors for `finishRegistration`. An app can show these
 * errors to the end user. The `error` field is a machine-readable code and
 * the discriminant of the union.
 */
export const finishRegistrationUserError = v.union(
  // The challenge is unknown, already used, or too old. The user must start
  // the ceremony again.
  v.object({ error: v.literal("CHALLENGE_EXPIRED") }),
  // The authenticator did not report user presence and user verification.
  v.object({ error: v.literal("VERIFICATION_FAILED") }),
  protocolError,
);
export type FinishRegistrationUserError = Infer<
  typeof finishRegistrationUserError
>;

/**
 * The user-facing errors for `finishAuthentication`. An app can show these
 * errors to the end user.
 */
export const finishAuthenticationUserError = v.union(
  // No stored passkey has the credential ID from the assertion. The
  // authenticator still offers a passkey that the app deleted.
  v.object({ error: v.literal("UNKNOWN_CREDENTIAL") }),
  v.object({ error: v.literal("CHALLENGE_EXPIRED") }),
  // The assertion is not valid. Possible causes: a bad signature, no user
  // presence or user verification, or a challenge for a different user.
  v.object({ error: v.literal("VERIFICATION_FAILED") }),
  protocolError,
);
export type FinishAuthenticationUserError = Infer<
  typeof finishAuthenticationUserError
>;

/**
 * The user-facing errors for `deletePasskey`. An app can show these errors
 * to the end user.
 */
export const deletePasskeyUserError = v.union(
  // The passkey does not exist, or it is the passkey of a different user.
  v.object({ error: v.literal("PASSKEY_NOT_FOUND") }),
);
export type DeletePasskeyUserError = Infer<typeof deletePasskeyUserError>;
