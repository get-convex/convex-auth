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
 * An email address that passed `validateEmailFormat`, with no other change.
 * It keeps the case that the user gave: the component shows this form to the
 * user and sends email to it, because the local part of an address can be
 * case-sensitive (RFC 5321).
 */
export type VerbatimEmail = string & { readonly __brand: "VerbatimEmail" };

/**
 * An email address after `normalizeEmail`. Lookups and uniqueness checks use
 * this form, never the `VerbatimEmail`.
 */
export type NormalizedEmail = string & { readonly __brand: "NormalizedEmail" };

/**
 * Examine an email address against the format rules. Return the address as a
 * `VerbatimEmail` when it is acceptable, or an `INVALID_EMAIL` user error for
 * a malformed address.
 */
export function validateEmailFormat(
  email: string,
):
  | { success: true; email: VerbatimEmail }
  | { success: false; userError: EmailFormatUserError } {
  if (email.length > MAX_EMAIL_LENGTH || !EMAIL_PATTERN.test(email)) {
    return { success: false, userError: { error: "INVALID_EMAIL" } };
  }
  return { success: true, email: email as VerbatimEmail };
}

/**
 * The user-facing errors for the `start` mutations. An application can show
 * these errors to the end user.
 */
export const startChallengeUserError = v.union(
  emailFormatUserError,
  v.object({ error: v.literal("RATE_LIMITED"), retryAfterMs: v.number() }),
);
export type StartChallengeUserError = Infer<typeof startChallengeUserError>;

/**
 * Another user has already verified this address. Only the kinds that record
 * the address for a user (`addEmail`, `changeEmail`, `signUp`) return this
 * error.
 */
export const emailTakenUserError = v.object({
  error: v.literal("EMAIL_TAKEN"),
});
export type EmailTakenUserError = Infer<typeof emailTakenUserError>;

/**
 * The user-facing errors for the `start` mutations of the kinds that record
 * the address for a user: the shared errors, plus `EMAIL_TAKEN`.
 */
export const startFreeAddressUserError = v.union(
  startChallengeUserError,
  emailTakenUserError,
);
export type StartFreeAddressUserError = Infer<typeof startFreeAddressUserError>;

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
);
export type CompleteChallengeUserError = Infer<
  typeof completeChallengeUserError
>;

/**
 * The challenge is for another user than the caller. For example, a user
 * starts a flow, signs out, and another user signs in in the same browser.
 * The challenge stays: the user must sign in with the account that started
 * the flow, and open the link again. Only the kinds that take a user return
 * this error (`addEmail`, `changeEmail`, and `custom`).
 */
export const wrongUserUserError = v.object({
  error: v.literal("WRONG_USER"),
});
export type WrongUserUserError = Infer<typeof wrongUserUserError>;

/**
 * The user-facing errors for the `complete` mutations of the kinds that
 * record the address for a user: the shared errors, plus `EMAIL_TAKEN` when
 * another user verified the address after the flow started.
 */
export const completeFreeAddressUserError = v.union(
  completeChallengeUserError,
  emailTakenUserError,
);
export type CompleteFreeAddressUserError = Infer<
  typeof completeFreeAddressUserError
>;

/** No user has verified this address. */
export const emailNotFoundUserError = v.object({
  error: v.literal("EMAIL_NOT_FOUND"),
});
export type EmailNotFoundUserError = Infer<typeof emailNotFoundUserError>;

/**
 * The owner that the address must have, at start and at completion:
 *
 * - `user`: the address must be a verified address of `userId`, and
 *   `currentUserId` must be `userId` at completion. For example, a new
 *   verification before a dangerous action.
 * - `anyUser`: the address must be a verified address of some user. The
 *   caller can be any user, or no user. For example, account recovery.
 * - `anyone`: the component does not check the owner of the address. The
 *   address can have no owner, and the caller can be any user, or no user.
 *   For example, a flow that proves control of an address before an account
 *   exists.
 *
 * In all kinds, `complete` gives the owner in `emailOwnerId`.
 */
export const vExpectedOwner = v.union(
  v.object({ kind: v.literal("user"), userId: v.string() }),
  v.object({ kind: v.literal("anyUser") }),
  v.object({ kind: v.literal("anyone") }),
);
export type ExpectedOwner = Infer<typeof vExpectedOwner>;

/**
 * The user-facing errors for the `start` and `check` mutations of the
 * `custom` kind: the shared errors, plus `EMAIL_NOT_FOUND` when the owner of
 * the address does not satisfy the `expectedOwner`.
 */
export const startCustomUserError = v.union(
  startChallengeUserError,
  emailNotFoundUserError,
);
export type StartCustomUserError = Infer<typeof startCustomUserError>;

/**
 * The result of `lookupEmail`: the user that the address identifies, and the
 * stored form of the address. `RATE_LIMITED` means that the client IP has
 * done too many lookups.
 */
export const lookupEmailResult = v.union(
  v.object({
    success: v.literal(true),
    userId: v.string(),
    // The address as the user verified it. It is the address that matched
    // the argument, not the primary address of the user. It can differ from
    // the argument in case or in Unicode form.
    storedEmail: v.string(),
  }),
  v.object({
    success: v.literal(false),
    userError: v.union(
      emailNotFoundUserError,
      v.object({ error: v.literal("RATE_LIMITED"), retryAfterMs: v.number() }),
    ),
  }),
);
export type LookupEmailResult = Infer<typeof lookupEmailResult>;

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
export function normalizeEmail(email: VerbatimEmail): NormalizedEmail {
  return email.toLowerCase().normalize("NFC") as NormalizedEmail;

  // Note that in theory, email addresses are case-sensitive (https://stackoverflow.com/a/9808332/4652564).
  // In this project we always store the `VerbatimEmail`, with the case that the
  // user used, but use the `NormalizedEmail` to check for existing accounts.
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
