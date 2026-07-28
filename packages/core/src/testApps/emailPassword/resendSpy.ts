import { internalMutation } from "./_generated/server";
import { Infer, v } from "convex/values";

/**
 * Test-only stand-in for `@convex-dev/resend`'s `lib.sendEmail`, so the full
 * flow can run without mounting the real resend component. `auth.ts` passes a
 * handle to this mutation as the email-validation `resend` reference; the
 * email-validation component calls it to "send" the code, and the test reads the
 * captured emails back to extract the code.
 *
 * convex-test runs the whole suite in one process, so a module-level log is a
 * stable spy.
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

/** Extract the short code from the most recent email's body (test-only). */
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

export const sendEmail = internalMutation({
  args: sendEmailArgs,
  returns: v.string(),
  handler: async (_ctx, args) => {
    sendEmailCalls.push({ ...args });
    return "test-email-id";
  },
});
