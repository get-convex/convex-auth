import { Infer, v } from "convex/values";

// The component applies only loose format rules: it rejects strings that can
// not be a deliverable address, and nothing more. Real ownership of the
// address is proven by the challenge, not by format checks.

// The longest address SMTP can deliver to (RFC 5321: 256 octets for the path,
// minus the angle brackets).
export const MAX_EMAIL_LENGTH = 254;

// One "@" with a non-empty local part, and a domain with at least one dot
// and no whitespace. Intentionally permissive: stricter patterns reject
// addresses that exist.
const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/u;

/**
 * The user-facing error for a malformed email address. An application can
 * show this error to the end user. The `error` field is a machine-readable
 * code and the discriminant of the union.
 */
export const emailFormatUserError = v.object({
  error: v.literal("INVALID_EMAIL"),
});
export type EmailFormatUserError = Infer<typeof emailFormatUserError>;

/**
 * Examine an email address against the format rules. Return an
 * `INVALID_EMAIL` user error for a malformed address, or `null` when the
 * address is acceptable.
 */
export function validateEmailFormat(
  email: string,
): EmailFormatUserError | null {
  if (email.length > MAX_EMAIL_LENGTH || !EMAIL_PATTERN.test(email)) {
    return { error: "INVALID_EMAIL" };
  }
  return null;
}

/**
 * The purpose of a challenge, as `challenge.start` accepts it. The
 * purpose controls what a successful completion does:
 *
 * - `addEmail`: prove that the address belongs to `userId`, then record it
 *   as an email address for the user (primary if it’s the first email address
 *   or secondary if it’s not).
 * - `setEmail`: similar to addEmail, but used in apps where users have a single
 *   email address. When the challenge is completed, we will always set the new
 *   email address as primary, and remove pre-existing email addresses.
 * - `passwordReset`: prove that the person owns an address that is already
 *   verified on the account. Completion writes nothing; it returns the
 *   `userId` as the ownership proof.
 */
export const vChallengePurposeArg = v.union(
  v.object({ kind: v.literal("addEmail"), userId: v.string() }),
  v.object({ kind: v.literal("setEmail"), userId: v.string() }),
  v.object({ kind: v.literal("passwordReset") }),
);
export type ChallengePurposeArg = Infer<typeof vChallengePurposeArg>;

/** The purpose kind alone, for completion-side checks. */
export const vPurposeKind = v.union(
  v.literal("addEmail"),
  v.literal("setEmail"),
  v.literal("passwordReset"),
);
export type PurposeKind = Infer<typeof vPurposeKind>;

/**
 * The user-facing errors for `challenge.start`. An application can show
 * these errors to the end user.
 */
export const startChallengeUserError = v.union(
  emailFormatUserError,
  // Another user has already verified this address (`addEmail`,
  // `setEmail`).
  v.object({ error: v.literal("EMAIL_TAKEN") }),
  // No user has verified this address (`passwordReset`).
  v.object({ error: v.literal("EMAIL_NOT_FOUND") }),
  v.object({ error: v.literal("RATE_LIMITED"), retryAfterMs: v.number() }),
);
export type StartChallengeUserError = Infer<typeof startChallengeUserError>;

/**
 * The user-facing errors for `challenge.complete`. `INVALID_LINK` covers an
 * unknown code, a wrong secret, an expired link, and a purpose mismatch: one
 * error for all of them, so the response is not an oracle for attackers.
 */
export const completeChallengeUserError = v.union(
  v.object({ error: v.literal("INVALID_LINK") }),
  // The address was verified by another user after the flow started.
  v.object({ error: v.literal("EMAIL_TAKEN") }),
);
export type CompleteChallengeUserError = Infer<
  typeof completeChallengeUserError
>;

/**
 * How `challenge.start` sends its email. The caller (the provider recipe)
 * resolves the function handle and the runtime options; the component only
 * calls the handle.
 *
 * Only Resend is supported for now, through the `@convex-dev/resend`
 * component's `lib.sendEmail` mutation.
 *
 * TODO: support other email providers.
 * TODO: offer a first-party zero-configuration email service.
 * TODO: let applications customize the email templates.
 */
export const vEmailSenderConfig = v.object({
  kind: v.literal("resend"),
  // Function handle for the Resend component's `lib.sendEmail` mutation.
  sendEmailHandle: v.string(),
  // The From address, e.g. `"My App <auth@example.com>"`.
  from: v.string(),
  // Runtime options that `lib.sendEmail` requires.
  apiKey: v.string(),
  testMode: v.boolean(),
  initialBackoffMs: v.number(),
  retryAttempts: v.number(),
});
export type EmailSenderConfig = Infer<typeof vEmailSenderConfig>;

/**
 * Normalize an email address for storage and comparisons.
 *
 * The function first makes the address lowercase, so that lookups are not
 * case-sensitive. Then it applies NFC normalization, so that two inputs that
 * a user sees as the same but that use different Unicode normalization forms
 * compare as equal. The order is important: the lowercase operation can make
 * a string that is not in the NFC form.
 */
export function normalizeEmail(email: string): string {
  return email.toLowerCase().normalize("NFC");

  // Note that in theory, email addresses are case-sensitive (https://stackoverflow.com/a/9808332/4652564).
  // In this project we always store the canonical email representation using the
  // case that the user used, but use a normalized lowercase version to check for existing accounts.
  //
  // This means that if Jane.Doe@example.com creates an account, we will store her email
  // as Jane.Doe@example.com (and the app will display her email using that case).
  // She will also be able to log in with jane.doe@example.com.
  // This is what we expect the correct behavior to be in practice.
  //
  // The only downside is that if jane.doe@example.com is a separate person,
  // she won’t be able to also create an account.
  // (But she won’t be able to perform account recovery to the original account,
  // as account recovery emails will be sent to Jane.Doe@example.com).
}

// Crypto helpers for the email component's challenge.

export function base64UrlEncode(bytes: Uint8Array): string {
  const binary = Array.from(bytes, (b) => String.fromCharCode(b)).join("");
  return btoa(binary)
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}

/** Cryptographically random 256-bit opaque token, base64url encoded. */
export function generateRandomToken(): string {
  return base64UrlEncode(crypto.getRandomValues(new Uint8Array(32)));
}
