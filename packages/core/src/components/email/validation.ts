/**
 * The validators, the error unions and the address helpers of the email
 * component. The function files and the recipe import it.
 *
 * @module
 */

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
 * The user-facing errors for the `start` mutations. An application can show
 * these errors to the end user.
 */
export const startChallengeUserError = v.union(
  emailFormatUserError,
  // Another user has already verified this address (`addEmail`,
  // `setPrimaryEmail`).
  v.object({ error: v.literal("EMAIL_TAKEN") }),
  v.object({ error: v.literal("RATE_LIMITED"), retryAfterMs: v.number() }),
);
export type StartChallengeUserError = Infer<typeof startChallengeUserError>;

/**
 * The user-facing errors for the `complete` mutations.
 *
 * `INVALID_CHALLENGE` means that there is no live challenge for the secret.
 * The challenge may have expired, may already have been used, or may never
 * have existed. The server cannot tell these apart, and the user action is
 * the same, start again.
 *
 * `INCORRECT_CODE` means that the challenge exists but the code does not
 * match. For a link, the link is not the newest one this browser started,
 * and the user must open the newest email. For a future short code, it is
 * a typo.
 */
export const completeChallengeUserError = v.union(
  v.object({ error: v.literal("INVALID_CHALLENGE") }),
  v.object({ error: v.literal("INCORRECT_CODE") }),
  // The address was verified by another user after the flow started.
  v.object({ error: v.literal("EMAIL_TAKEN") }),
);
export type CompleteChallengeUserError = Infer<
  typeof completeChallengeUserError
>;

/**
 * The flows of the EmailPassword provider that send a challenge link. A
 * landing page names its flow so the backend asks the matching challenge
 * kind for the status.
 */
export const vEmailPasswordFlow = v.union(
  v.literal("signUp"),
  v.literal("changeEmail"),
  v.literal("recovery"),
);
export type EmailPasswordFlow = Infer<typeof vEmailPasswordFlow>;

/**
 * How the `start` mutations send their email. The caller (the provider recipe)
 * resolves the function handle and the runtime options; the component only
 * calls the handle.
 *
 * Only Resend is supported for now, through the `@convex-dev/resend`
 * component's `lib.sendEmail` mutation.
 *
 * TODO: consider supporting other email providers.
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
