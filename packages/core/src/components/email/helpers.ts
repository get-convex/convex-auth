import { MutationCtx, QueryCtx } from "./_generated/server.ts";
import { Doc } from "./_generated/dataModel.ts";
import { components } from "./_generated/api.ts";
import { FunctionHandle } from "convex/server";
import { RateLimiter, HOUR } from "@convex-dev/rate-limiter";
import { EmailSenderConfig } from "./validation.ts";

// --- Configuration ---------------------------------------------------------

/**
 * How long an `addEmail` or `setPrimaryEmail` link stays valid.
 * TODO: review this value.
 */
export const ADD_EMAIL_TTL_MS = 60 * 60 * 1000; // 1 hour

/**
 * How long a `custom` link stays valid when the caller gives no `ttlMs`, and
 * the bounds for the value that a caller can give. The default is short: a
 * custom flow can give access to an account (OWASP ASVS v5 6.5.5 asks for at
 * most 10 minutes for password resets). The maximum keeps the table from
 * holding links for days.
 * TODO(nicolas): review the default and the bounds.
 */
export const CUSTOM_TTL_DEFAULT_MS = 15 * 60 * 1000; // 15 minutes
export const CUSTOM_TTL_MIN_MS = 60 * 1000; // 1 minute
export const CUSTOM_TTL_MAX_MS = 24 * 60 * 60 * 1000; // 24 hours

// Throttle for starting challenges. Each flow sends an email, so the
// limits protect the destination mailbox from flooding and the sender's
// reputation from abuse:
// - per destination address, so an attacker cannot flood one mailbox;
// - per client IP, so one machine cannot spray many addresses.
// TODO: review these limits.
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
  const meta = (ctx as Partial<MutationCtx>).meta;
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

/** The lines of a challenge email that depend on the flow. */
export type ChallengeEmailCopy = {
  subject: string;
  // The sentence before the link, for example "Open this link to validate
  // your email address:".
  intro: string;
};

/** The copy of the emails that record an address. */
export const VALIDATE_EMAIL_COPY: ChallengeEmailCopy = {
  subject: "Validate your email address",
  intro: "Open this link to validate your email address:",
};

/** "10 minutes", "1 hour", "2 hours". */
export function formatDuration(ms: number): string {
  const minutes = Math.round(ms / 60_000);
  if (minutes >= 60 && minutes % 60 === 0) {
    const hours = minutes / 60;
    return hours === 1 ? "1 hour" : `${hours} hours`;
  }
  return minutes === 1 ? "1 minute" : `${minutes} minutes`;
}

/** The plain-text body of a challenge email. */
export function challengeEmailText(
  intro: string,
  link: string,
  ttlMs: number,
): string {
  // TODO: also offer a short code the user can type, with rate limiting on
  // attempts (a short code is guessable, unlike the 256-bit link code).
  return (
    `${intro}\n\n` +
    `${link}\n\n` +
    `The link stops working after ${formatDuration(ttlMs)}, and works only ` +
    "in the browser you started from.\n\n" +
    "If you did not request this email, you can ignore it."
  );
}

/** Append the code to the landing URL, with `?` or `&` as needed. */
export function buildLink(url: string, code: string): string {
  const separator = url.includes("?") ? "&" : "?";
  return `${url}${separator}code=${encodeURIComponent(code)}`;
}

/** The `sendEmail` mutation of the `@convex-dev/resend` component. */
export type SendEmailHandle = FunctionHandle<
  "mutation",
  {
    options: {
      apiKey: string;
      testMode: boolean;
      initialBackoffMs: number;
      retryAttempts: number;
    };
    from: string;
    to: string[];
    subject: string;
    text: string;
  },
  string
>;

export async function sendChallengeEmail(
  ctx: MutationCtx,
  sender: EmailSenderConfig,
  message: {
    to: string;
    copy: ChallengeEmailCopy;
    link: string;
    ttlMs: number;
  },
): Promise<void> {
  await ctx.runMutation(sender.sendEmailHandle as SendEmailHandle, {
    options: {
      apiKey: sender.apiKey,
      testMode: sender.testMode,
      initialBackoffMs: sender.initialBackoffMs,
      retryAttempts: sender.retryAttempts,
    },
    from: sender.from,
    to: [message.to],
    subject: message.copy.subject,
    text: challengeEmailText(message.copy.intro, message.link, message.ttlMs),
  });
}
