import { Infer, v } from "convex/values";

// How long a stored challenge stays valid. The WebAuthn spec recommends
// ceremony timeouts of 5–10 minutes to leave room for user interaction
// (PIN entry, cross-device flows); we match the upper bound. Expiring
// challenges bounds the window for replay of an intercepted challenge.
// https://www.w3.org/TR/webauthn-3/#sctn-timeout-recommended-range
export const CHALLENGE_TTL_MS = 10 * 60 * 1000; // 10 minutes

// The COSE signature algorithms this provider accepts, as IANA identifiers
// (https://www.iana.org/assignments/cose/cose.xhtml#algorithms). This list
// is enforced when the attestation is verified. The client offers its own
// `pubKeyCredParams` literal in `react.tsx`, so keep the two lists in sync
// by hand. `@simplewebauthn/server` also verifies Ed25519 (-8).
export const SUPPORTED_ALGORITHM_IDS = [
  -7, // ES256
  -257, // RS256
];

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
 * The largest length of a `purpose` string. A purpose names one flow of the
 * app ("myApp:signIn"), thus a short limit is enough. The limit stops a
 * caller from writing large data to a challenge row.
 */
const MAX_PURPOSE_LENGTH = 128;

// The characters that a purpose can contain: printable ASCII without the
// space. The component does not parse the value beyond this.
const PURPOSE_PATTERN = /^[\x21-\x7e]+$/;

/**
 * Show a purpose in an error message. The value comes from the caller,
 * thus it can be long, empty, or contain characters that are not
 * printable. `JSON.stringify` puts it in quotation marks and replaces
 * these characters. A long value is cut to keep the message short.
 */
function describePurpose(value: string) {
  const shown =
    value.length > MAX_PURPOSE_LENGTH
      ? `${value.slice(0, MAX_PURPOSE_LENGTH)}…`
      : value;
  return JSON.stringify(shown);
}

/**
 * Examine the `purpose` of an authentication challenge, before the component
 * stores it or compares it.
 *
 * The component does not give the purposes a meaning: the app chooses the
 * strings. It only refuses a values that are not well formatted
 * (maximum 128 non-space printable ASCII characters).
 *
 * @throws when the value is empty, too long, or not printable ASCII.
 */
export function validatePurpose(purpose: string) {
  if (purpose.length > MAX_PURPOSE_LENGTH) {
    throw new Error(
      `Purpose too long: ${describePurpose(purpose)} has ${purpose.length} characters, but a purpose can have a maximum of ${MAX_PURPOSE_LENGTH}.`,
    );
  }
  if (!PURPOSE_PATTERN.test(purpose)) {
    throw new Error(
      `Invalid purpose: ${describePurpose(purpose)} is not a non-empty string of printable ASCII characters.`,
    );
  }
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
 * The user-facing errors for the registration finish functions. An app can
 * show these errors to the end user. The `error` field is a machine-readable
 * code and the discriminant of the union.
 */
export const finishRegistrationUserError = v.union(
  // The challenge is unknown, already used, or too old. The user must start
  // the ceremony again.
  v.object({ error: v.literal("CHALLENGE_EXPIRED") }),
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

/**
 * The user-facing error when the caller of a passkey-management function is
 * not signed in. Each of those functions acts on the passkeys of the
 * caller, thus a signed-out caller has nothing to act on.
 */
export const notSignedInUserError = v.object({
  error: v.literal("NOT_SIGNED_IN"),
});
export type NotSignedInUserError = Infer<typeof notSignedInUserError>;
