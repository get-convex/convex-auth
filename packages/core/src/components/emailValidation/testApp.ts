import { internalMutation } from "./_generated/server";
import { Infer, v } from "convex/values";

/**
 * Test-only spy for `@convex-dev/resend`'s `lib.sendEmail`. The
 * email-validation component delivers the short code by calling a function
 * handle the app passes in; in tests we hand it a handle to this spy instead of
 * the real resend component, and assert on / read back the emails it "sent".
 *
 * convex-test runs the whole suite in one process, so a module-level log is a
 * stable spy; the reader and reset below are plain functions the test imports
 * directly rather than Convex functions. This file is excluded from the
 * published build, so the global state never reaches production.
 */
const sendEmailArgs = v.object({
  from: v.string(),
  to: v.array(v.string()),
  subject: v.optional(v.string()),
  text: v.optional(v.string()),
  options: v.object({
    apiKey: v.string(),
    testMode: v.boolean(),
    retryAttempts: v.number(),
    initialBackoffMs: v.number(),
  }),
});
type SendEmailCall = Infer<typeof sendEmailArgs>;
const sendEmailCalls: SendEmailCall[] = [];

/** Read the recorded `sendEmail` calls (test-only). */
export function getSendEmailCalls(): readonly SendEmailCall[] {
  return sendEmailCalls;
}

/** Clear the recorded calls so a test can assert in isolation (test-only). */
export function resetSendEmailCalls(): void {
  sendEmailCalls.length = 0;
}

/**
 * Extract the short code from the most recent email's body. Throws if no email
 * was sent or the body doesn't contain a code (a test-only convenience).
 */
export function getLastEmailedCode(): string {
  const last = sendEmailCalls[sendEmailCalls.length - 1];
  if (last === undefined) {
    throw new Error("No email has been sent.");
  }
  const match = last.text?.match(/code is: ([A-Z0-9]+)/);
  if (!match) {
    throw new Error(`Could not find a code in the email body: ${last.text}`);
  }
  return match[1];
}

/**
 * Stand-in for resend's `lib.sendEmail`, matching the argument shape the
 * email-validation component sends. Records the call and returns a fake email
 * id.
 */
export const sendEmail = internalMutation({
  args: sendEmailArgs,
  returns: v.string(),
  handler: async (_ctx, args) => {
    sendEmailCalls.push({ ...args });
    return "test-email-id";
  },
});
