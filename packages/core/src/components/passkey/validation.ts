import { Infer, v } from "convex/values";

// How long a stored challenge stays valid. The WebAuthn spec recommends
// ceremony timeouts of 5–10 minutes to leave room for user interaction
// (PIN entry, cross-device flows); we match the upper bound. Expiring
// challenges bounds the window for replay of an intercepted challenge.
// https://www.w3.org/TR/webauthn-3/#sctn-timeout-recommended-range
export const CHALLENGE_TTL_MS = 10 * 60 * 1000; // 10 minutes

// The COSE signature algorithms this provider accepts, as IANA identifiers
// (https://www.iana.org/assignments/cose/cose.xhtml#algorithms). The same
// list is offered to the authenticator in `pubKeyCredParams` and enforced
// when the attestation is verified, so the two can never disagree.
// `@simplewebauthn/server` also verifies Ed25519 (-8); adding it here is the
// only change needed to accept it.
export const SUPPORTED_ALGORITHM_IDS = [
  -7, // ES256
  -257, // RS256
];

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
