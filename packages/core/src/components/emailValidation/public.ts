import { mutation, QueryCtx } from "./_generated/server";
import { Doc } from "./_generated/dataModel";
import { components } from "./_generated/api";
import { Infer, v } from "convex/values";
import { FunctionHandle } from "convex/server";
import { RateLimiter, MINUTE } from "@convex-dev/rate-limiter";
import {
  buildSessionString,
  bytesToUint8Array,
  constantTimeEqual,
  generateSessionSecret,
  generateShortCode,
  hashSecret,
  normalizeShortCode,
  parseSessionString,
} from "../../lib/genericSession";

// A validation session is valid for 10 minutes. Short enough that a leaked code
// is only briefly useful, long enough for a user to fetch and enter it.
const SESSION_TTL_MS = 10 * MINUTE;

// Two throttles, both token buckets, following the same reasoning as the
// password component (https://auth.pilcrowonpaper.com/passwords):
//
// - `sendValidationEmail` is keyed by the (normalized) email address so that
//   repeated sign-ups can't be used to spam a single inbox. Rate 1/min with a
//   small burst capacity covers legitimate retries.
// - `consumeSession` is keyed by the session id so that guessing the short code
//   is bounded (~5 attempts/min), mirroring `verifyPassword`. The ~40-bit code
//   is only safe *because* of this limit.
const rateLimiter = new RateLimiter(components.rateLimiter, {
  sendValidationEmail: {
    kind: "token bucket",
    rate: 1,
    period: MINUTE,
    capacity: 3,
  },
  consumeSession: {
    kind: "token bucket",
    rate: 1,
    period: MINUTE,
    capacity: 5,
  },
});

// The subset of `@convex-dev/resend`'s `lib.sendEmail` that we call. Declared
// locally (rather than importing the resend types) so this component-internal
// module carries no dependency on resend — the app passes in a serialized
// handle to the mounted resend component's mutation.
type SendEmailHandle = FunctionHandle<
  "mutation",
  {
    from: string;
    to: string[];
    subject?: string;
    text?: string;
    options: {
      apiKey: string;
      testMode: boolean;
      retryAttempts: number;
      initialBackoffMs: number;
    };
  },
  string
>;

const createSessionResult = v.union(
  v.object({ ok: v.literal(true), session: v.string() }),
  v.object({
    ok: v.literal(false),
    userError: v.object({
      error: v.literal("RATE_LIMITED"),
      retryAfterMs: v.number(),
    }),
  }),
);
type CreateSessionResult = Infer<typeof createSessionResult>;

/**
 * Start an email-validation session for a user: generate a bearer secret and a
 * short code, store their hashes with a 10-minute expiry, and email the code via
 * the provided resend handle. Returns the client-facing `<id>.<secret>` string
 * — the only place the secret is ever revealed.
 *
 * Throttled per email address (see `rateLimiter`). Any prior session for the
 * user is replaced, so only the most recent code/secret is accepted.
 */
export const createSession = mutation({
  args: {
    userId: v.string(),
    email: v.string(),
    send: v.object({
      // FunctionHandle to `@convex-dev/resend`'s `lib.sendEmail`.
      handle: v.string(),
      from: v.string(),
      apiKey: v.string(),
      testMode: v.boolean(),
    }),
  },
  returns: createSessionResult,
  handler: async (
    ctx,
    { userId, email, send },
  ): Promise<CreateSessionResult> => {
    // Rate-limit *before* doing any work, keyed by the address being emailed.
    const status = await rateLimiter.limit(ctx, "sendValidationEmail", {
      key: email,
    });
    if (!status.ok) {
      return {
        ok: false,
        userError: { error: "RATE_LIMITED", retryAfterMs: status.retryAfter },
      };
    }

    // Single active session per user: drop any prior rows.
    for (const prior of await sessionsByUserId(ctx, userId)) {
      await ctx.db.delete("emailValidationSessions", prior._id);
    }

    const secret = generateSessionSecret();
    const code = generateShortCode();
    const sessionId = await ctx.db.insert("emailValidationSessions", {
      userId,
      email,
      secretHash: hashSecret(secret),
      codeHash: hashSecret(code),
      expiresAt: Date.now() + SESSION_TTL_MS,
    });

    // TODO: make the subject/body customizable by the app.
    await ctx.runMutation(send.handle as SendEmailHandle, {
      from: send.from,
      to: [email],
      subject: "Confirm your email address",
      text: `Your confirmation code is: ${code}\n\nThis code expires in 10 minutes. If you didn't request it, you can ignore this email.`,
      options: {
        apiKey: send.apiKey,
        testMode: send.testMode,
        retryAttempts: 5,
        initialBackoffMs: 30_000,
      },
    });

    return { ok: true, session: buildSessionString(sessionId, secret) };
  },
});

const consumeSessionResult = v.union(
  v.object({ valid: v.literal(true), userId: v.string(), email: v.string() }),
  v.object({
    valid: v.literal(false),
    error: v.union(
      v.literal("INVALID"),
      v.literal("EXPIRED"),
      v.literal("RATE_LIMITED"),
    ),
    retryAfterMs: v.optional(v.number()),
  }),
);
type ConsumeSessionResult = Infer<typeof consumeSessionResult>;

/**
 * Verify and consume a validation session. Both the bearer secret (from the
 * `<id>.<secret>` string) and the short code must match; on success the session
 * is deleted (single-use) and the `{ userId, email }` it was created for is
 * returned so the caller can complete sign-up.
 *
 * Throttled per session id (see `rateLimiter`) so the low-entropy code can't be
 * brute-forced. A wrong code leaves the row in place (bounded by the limit); an
 * expired session is deleted.
 */
export const consumeSession = mutation({
  args: { session: v.string(), code: v.string() },
  returns: consumeSessionResult,
  handler: async (ctx, { session, code }): Promise<ConsumeSessionResult> => {
    const parsed = parseSessionString(session);
    if (parsed === null) {
      return { valid: false, error: "INVALID" };
    }

    // Rate-limit keyed by the session id (the public half of the string).
    const status = await rateLimiter.limit(ctx, "consumeSession", {
      key: parsed.id,
    });
    if (!status.ok) {
      return {
        valid: false,
        error: "RATE_LIMITED",
        retryAfterMs: status.retryAfter,
      };
    }

    const id = ctx.db.normalizeId("emailValidationSessions", parsed.id);
    const row =
      id === null ? null : await ctx.db.get("emailValidationSessions", id);
    if (row === null) {
      return { valid: false, error: "INVALID" };
    }

    if (row.expiresAt < Date.now()) {
      await ctx.db.delete("emailValidationSessions", row._id);
      return { valid: false, error: "EXPIRED" };
    }

    // Compare both hashes in constant time, and evaluate *both* comparisons
    // before branching so the response time doesn't reveal which half matched.
    const secretMatches = constantTimeEqual(
      bytesToUint8Array(hashSecret(parsed.secret)),
      bytesToUint8Array(row.secretHash),
    );
    const codeMatches = constantTimeEqual(
      bytesToUint8Array(hashSecret(normalizeShortCode(code))),
      bytesToUint8Array(row.codeHash),
    );
    if (!(secretMatches && codeMatches)) {
      // Keep the row: further attempts are bounded by the rate limit.
      return { valid: false, error: "INVALID" };
    }

    // Single-use: consume the session on success.
    await ctx.db.delete("emailValidationSessions", row._id);
    return { valid: true, userId: row.userId, email: row.email };
  },
});

function sessionsByUserId(
  ctx: QueryCtx,
  userId: string,
): Promise<Doc<"emailValidationSessions">[]> {
  return ctx.db
    .query("emailValidationSessions")
    .withIndex("by_userId", (q) => q.eq("userId", userId))
    .collect();
}
