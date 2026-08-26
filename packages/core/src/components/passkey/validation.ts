import { Infer, v } from "convex/values";

// How long a stored challenge stays valid. The WebAuthn spec recommends
// ceremony timeouts of 5–10 minutes to leave room for user interaction
// (PIN entry, cross-device flows); we match the upper bound. Expiring
// challenges bounds the window for replay of an intercepted challenge.
// https://www.w3.org/TR/webauthn-3/#sctn-timeout-recommended-range
export const CHALLENGE_TTL_MS = 10 * 60 * 1000; // 10 minutes

/**
 * The ways that the browser can reach an authenticator, for example
 * "internal", "usb", or "hybrid". The browser reports them when it makes a
 * credential. A later ceremony sends them back to the browser, which then
 * shows the correct instructions to the user.
 *
 * The values are plain strings and not an enumeration. The WebAuthn spec
 * lets new transports appear, and it tells a relying party to keep an
 * unknown value without a change.
 * https://www.w3.org/TR/webauthn-3/#enum-transport
 */
export const transports = v.optional(v.array(v.string()));

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
 *
 * @throws when there are too many values, or when a value is empty, too
 * long, or not printable ASCII.
 */
export function validateTransports(values: string[] | undefined) {
  if (values === undefined) {
    return;
  }
  if (values.length > MAX_TRANSPORTS) {
    throw new Error(
      `Too many transports: a credential can have a maximum of ${MAX_TRANSPORTS}.`,
    );
  }
  for (const value of values) {
    if (value.length > MAX_TRANSPORT_LENGTH) {
      throw new Error(
        `Transport too long: a transport can have a maximum of ${MAX_TRANSPORT_LENGTH} characters.`,
      );
    }
    if (!TRANSPORT_PATTERN.test(value)) {
      throw new Error(
        "Invalid transport: a transport must be a non-empty string of printable ASCII characters.",
      );
    }
  }
}

/**
 * One entry of `allowCredentials` or `excludeCredentials`. The WebAuthn
 * `type` field is not included, because it is always "public-key".
 */
export const credentialDescriptor = v.object({
  id: v.bytes(),
  transports,
});
export type CredentialDescriptor = Infer<typeof credentialDescriptor>;

/**
 * The user-facing errors for `finishRegistration`. An app can show these
 * errors to the end user. The `error` field is a machine-readable code and
 * the discriminant of the union.
 *
 * Protocol violations (an unexpected origin, a malformed attestation, an
 * unsupported algorithm, …) are not part of this union. They show a
 * configuration error or a tampered client, not a condition that the user
 * can correct. For these violations, the component throws an error. The
 * error also aborts the transaction around the call.
 */
export const finishRegistrationUserError = v.union(
  // The challenge is unknown, already used, or too old. The user must start
  // the ceremony again.
  v.object({ error: v.literal("CHALLENGE_EXPIRED") }),
  // The authenticator did not report user presence and user verification.
  v.object({ error: v.literal("VERIFICATION_FAILED") }),
);
export type FinishRegistrationUserError = Infer<
  typeof finishRegistrationUserError
>;

/**
 * The user-facing errors for `finishAuthentication`. An app can show these
 * errors to the end user.
 */
export const finishAuthenticationUserError = v.union(
  // No stored passkey has the credential ID from the assertion.
  v.object({ error: v.literal("UNKNOWN_CREDENTIAL") }),
  v.object({ error: v.literal("CHALLENGE_EXPIRED") }),
  // The assertion is not valid. Possible causes: a bad signature, no user
  // presence or user verification, or a challenge for a different user.
  v.object({ error: v.literal("VERIFICATION_FAILED") }),
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
