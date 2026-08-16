import { mutation, query } from "./_generated/server.ts";
import { Infer, v } from "convex/values";
import { sha256Hex } from "../../lib/crypto.ts";
import {
  CHALLENGE_TTL_MS,
  rateLimiter,
  getClientIp,
  emailsByUserId,
  emailByNormalizedEmail,
  buildLink,
  sendChallengeEmail,
} from "./helpers.ts";
import {
  validateEmailFormat,
  startChallengeUserError,
  completeChallengeUserError,
  vEmailSenderConfig,
  normalizeEmail,
  generateRandomToken,
} from "./validation.ts";

// A challenge proves that the person who started it owns an email address.
// On completion, the address is recorded as a verified email of the user
// the challenge was started for.

const checkStartChallengeResult = v.union(
  v.object({ ok: v.literal(true) }),
  v.object({ ok: v.literal(false), retryAfterMs: v.number() }),
);
type CheckStartChallengeResult = Infer<typeof checkStartChallengeResult>;

/**
 * Tell whether `challenge.start` would be rate limited, without consuming
 * the limits.
 *
 * Callers that must do other work before `challenge.start` (for example,
 * create the user) call this first and stop early on a limit, so the other
 * work is not committed when the flow cannot start. The check and the later
 * consumption run in one transaction when both happen in one mutation, so a
 * passing check cannot turn into a failing consumption.
 */
export const checkStart = mutation({
  args: { email: v.string() },
  returns: checkStartChallengeResult,
  handler: async (ctx, { email }): Promise<CheckStartChallengeResult> => {
    const key = normalizeEmail(email);
    const ip = await getClientIp(ctx);
    const perEmail = await rateLimiter.check(ctx, "startChallengePerEmail", {
      key,
    });
    const perIp = await rateLimiter.check(ctx, "startChallengePerIp", {
      key: ip,
    });
    if (!perEmail.ok || !perIp.ok) {
      return {
        ok: false,
        retryAfterMs: Math.max(
          perEmail.ok ? 0 : perEmail.retryAfter,
          perIp.ok ? 0 : perIp.retryAfter,
        ),
      };
    }
    return { ok: true };
  },
});

const startChallengeResult = v.union(
  v.object({
    success: v.literal(true),
    // The secret the client must keep (in its local storage) and present
    // again at completion. It never travels in the email.
    secret: v.string(),
  }),
  v.object({ success: v.literal(false), userError: startChallengeUserError }),
);
type StartChallengeResult = Infer<typeof startChallengeResult>;

/**
 * Start a challenge: check the address, consume the rate limits, store the
 * hashed code + secret, and send the email.
 *
 * The emailed link carries the code; the returned secret stays in the
 * starting browser. Completion requires both, so a person who only sees the
 * email (or only sees the database) cannot complete the flow.
 *
 * The address must not be verified for another user (`EMAIL_TAKEN`).
 *
 * `url` is the landing page the link points at; the code is appended as the
 * `code` query parameter. The caller controls this value — do not pass
 * client-supplied URLs, or the email becomes a phishing vector from a
 * legitimate sender.
 */
export const start = mutation({
  args: {
    email: v.string(),
    userId: v.string(),
    url: v.string(),
    emailSender: vEmailSenderConfig,
  },
  returns: startChallengeResult,
  handler: async (ctx, args): Promise<StartChallengeResult> => {
    const formatError = validateEmailFormat(args.email);
    if (formatError !== null) {
      return { success: false, userError: formatError };
    }
    // `email` keeps the case the user gave: the link goes to that address and
    // a completion records it. `normalizedEmail` is the lookup key.
    const email = args.email;
    const normalizedEmail = normalizeEmail(email);

    // Consume both rate limits. A failure after `challenge.checkStart`
    // passed in the same mutation is unexpected (same transaction), so
    // callers that pre-checked treat the `RATE_LIMITED` arm as unreachable.
    const ip = await getClientIp(ctx);
    const perEmail = await rateLimiter.limit(ctx, "startChallengePerEmail", {
      key: normalizedEmail,
    });
    if (!perEmail.ok) {
      return {
        success: false,
        userError: { error: "RATE_LIMITED", retryAfterMs: perEmail.retryAfter },
      };
    }
    const perIp = await rateLimiter.limit(ctx, "startChallengePerIp", {
      key: ip,
    });
    if (!perIp.ok) {
      return {
        success: false,
        userError: { error: "RATE_LIMITED", retryAfterMs: perIp.retryAfter },
      };
    }

    if ((await emailByNormalizedEmail(ctx, normalizedEmail)) !== null) {
      return { success: false, userError: { error: "EMAIL_TAKEN" } };
    }

    const code = generateRandomToken();
    const secret = generateRandomToken();
    await ctx.db.insert("challenges", {
      email,
      userId: args.userId,
      codeHash: await sha256Hex(code),
      secretHash: await sha256Hex(secret),
      expiresAt: Date.now() + CHALLENGE_TTL_MS,
    });

    await sendChallengeEmail(
      ctx,
      args.emailSender,
      email,
      buildLink(args.url, code),
    );

    return { success: true, secret };
  },
});

const completeChallengeResult = v.union(
  v.object({
    success: v.literal(true),
    userId: v.string(),
    email: v.string(),
    isPrimary: v.boolean(),
  }),
  v.object({
    success: v.literal(false),
    userError: completeChallengeUserError,
  }),
);
type CompleteChallengeResult = Infer<typeof completeChallengeResult>;

/**
 * Complete a challenge with the code from the link and the secret from the
 * starting browser, and record the address as a verified email of the user.
 *
 * The claim is one-shot: the row is deleted as soon as the code matches,
 * even when the secret is wrong or the link has expired, so a link can never
 * be replayed. An unknown code, a wrong secret and an expired link all
 * return the same `INVALID_LINK` error.
 *
 * The first address of a user becomes primary; later addresses are
 * secondary. TODO: add a component function to change the primary address.
 */
export const complete = mutation({
  args: { code: v.string(), secret: v.string() },
  returns: completeChallengeResult,
  handler: async (ctx, args): Promise<CompleteChallengeResult> => {
    const codeHash = await sha256Hex(args.code);
    const row = await ctx.db
      .query("challenges")
      .withIndex("by_codeHash", (q) => q.eq("codeHash", codeHash))
      .unique();
    if (row === null) {
      return { success: false, userError: { error: "INVALID_LINK" } };
    }
    // One-shot claim: delete before any check, so a raced or replayed
    // completion finds nothing.
    await ctx.db.delete("challenges", row._id);

    if (
      row.secretHash !== (await sha256Hex(args.secret)) ||
      row.expiresAt < Date.now()
    ) {
      return { success: false, userError: { error: "INVALID_LINK" } };
    }

    // The address must still be free: another user may have verified it
    // after this challenge started.
    const normalizedEmail = normalizeEmail(row.email);
    if ((await emailByNormalizedEmail(ctx, normalizedEmail)) !== null) {
      return { success: false, userError: { error: "EMAIL_TAKEN" } };
    }

    const isPrimary = (await emailsByUserId(ctx, row.userId)).length === 0;
    await ctx.db.insert("verifiedEmails", {
      email: row.email,
      normalizedEmail,
      userId: row.userId,
      isPrimary,
      source: { kind: "self" },
    });
    return { success: true, userId: row.userId, email: row.email, isPrimary };
  },
});

const challengeStatus = v.union(
  v.object({ status: v.literal("pending"), email: v.string() }),
  v.object({ status: v.literal("invalid") }),
);
type ChallengeStatus = Infer<typeof challengeStatus>;

/**
 * Report the state of a challenge without claiming it.
 *
 * Landing pages call this to show which address the link will verify before
 * the user confirms. The checks are the same as `challenge.complete`,
 * including the secret, so a person who only has the link learns nothing.
 */
export const getStatus = query({
  args: { code: v.string(), secret: v.string() },
  returns: challengeStatus,
  handler: async (ctx, args): Promise<ChallengeStatus> => {
    const codeHash = await sha256Hex(args.code);
    const row = await ctx.db
      .query("challenges")
      .withIndex("by_codeHash", (q) => q.eq("codeHash", codeHash))
      .unique();
    if (
      row === null ||
      row.secretHash !== (await sha256Hex(args.secret)) ||
      row.expiresAt < Date.now()
    ) {
      return { status: "invalid" };
    }
    return { status: "pending", email: row.email };
  },
});
