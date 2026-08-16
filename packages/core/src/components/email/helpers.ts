import { MutationCtx, QueryCtx } from "./_generated/server.ts";
import { Doc } from "./_generated/dataModel.ts";
import { components } from "./_generated/api.ts";
import {
  FunctionArgs,
  FunctionHandle,
  FunctionReturnType,
} from "convex/server";
import type { ResendComponent } from "@convex-dev/resend";
import { RateLimiter, HOUR } from "@convex-dev/rate-limiter";
import { EmailSenderConfig } from "./validation.ts";

// --- Configuration ---------------------------------------------------------

/** How long a link stays valid. TODO: review this value. */
export const CHALLENGE_TTL_MS = 60 * 60 * 1000; // 1 hour

// Throttle for starting challenges. Each flow sends an email, so the
// limits protect the destination mailbox from flooding and the sender's
// reputation from abuse:
// - per destination address, so an attacker cannot flood one mailbox;
// - per client IP, so one machine cannot spray many addresses.
// TODO(nicolas): review these limits.
export const rateLimiter = new RateLimiter(components.rateLimiter, {
  startChallengePerEmail: { kind: "token bucket", rate: 5, period: HOUR },
  startChallengePerIp: { kind: "token bucket", rate: 20, period: HOUR },
});

// --- Shared helpers --------------------------------------------------------

/**
 * The client IP of the request, for rate limiting.
 *
 * Throws when the backend does not expose request metadata (`ctx.meta`
 * requires a Convex backend from July 2026 or later) or when the call did
 * not come from a request with an IP. There is no fallback: without an IP
 * the per-IP rate limit would not protect anything.
 */
export async function getClientIp(ctx: MutationCtx): Promise<string> {
  // Old backends (and convex-test) have no `ctx.meta`.
  const meta = ctx.meta;
  if (meta === undefined) {
    throw new Error(
      "The email component requires `ctx.meta` for IP rate limiting. " +
        "Upgrade your Convex backend to a version that supplies request " +
        "metadata to component functions.",
    );
  }
  const { ip } = await meta.getRequestMetadata();
  if (ip === null) {
    throw new Error(
      "The email component could not read the client IP for rate " +
        "limiting. Start challenges from a client request, not from " +
        "a scheduled or cron function.",
    );
  }
  return ip;
}

export function emailsByUserId(
  ctx: QueryCtx,
  userId: string,
): Promise<Doc<"verifiedEmails">[]> {
  return ctx.db
    .query("verifiedEmails")
    .withIndex("by_userId", (q) => q.eq("userId", userId))
    .collect();
}

export function emailByNormalizedEmail(
  ctx: QueryCtx,
  normalizedEmail: string,
): Promise<Doc<"verifiedEmails"> | null> {
  return ctx.db
    .query("verifiedEmails")
    .withIndex("by_normalizedEmail", (q) =>
      q.eq("normalizedEmail", normalizedEmail),
    )
    .unique();
}

/** The plain-text body of a challenge email. */
export function challengeEmailText(link: string): string {
  // TODO: also offer a short code the user can type, with rate limiting on
  // attempts (a short code is guessable, unlike the 256-bit link code).
  return (
    "Open this link to confirm that this email address is yours:\n\n" +
    `${link}\n\n` +
    "The link stops working after 1 hour, and works only in the browser " +
    "you started from.\n\n" +
    "If you did not request this email, you can ignore it."
  );
}

/** The subject line of a challenge email. */
export function challengeEmailSubject(): string {
  return "Confirm your email address";
}

/**
 * The landing URL with the `code` query parameter.
 *
 * The URL must be absolute. A fragment stays at the end of the URL, and an
 * existing `code` parameter is replaced.
 */
export function buildLink(url: string, code: string): string {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new Error(
      `The email component got an invalid landing URL: ${url}. ` +
        "Give an absolute URL, for example https://example.com/verify.",
    );
  }
  parsed.searchParams.set("code", code);
  return parsed.toString();
}

/** The `sendEmail` mutation of the `@convex-dev/resend` component. */
type SendEmailMutation = ResendComponent["lib"]["sendEmail"];

export type SendEmailHandle = FunctionHandle<
  "mutation",
  FunctionArgs<SendEmailMutation>,
  FunctionReturnType<SendEmailMutation>
>;

export async function sendChallengeEmail(
  ctx: MutationCtx,
  sender: EmailSenderConfig,
  to: string,
  link: string,
): Promise<void> {
  await ctx.runMutation(sender.sendEmailHandle as SendEmailHandle, {
    options: {
      apiKey: sender.apiKey,
      testMode: sender.testMode,
      initialBackoffMs: sender.initialBackoffMs,
      retryAttempts: sender.retryAttempts,
    },
    from: sender.from,
    to: [to],
    subject: challengeEmailSubject(),
    text: challengeEmailText(link),
  });
}
