import { mutation, query } from "./_generated/server.ts";
import { Infer, v } from "convex/values";
import { sha256Hex } from "../../lib/crypto.ts";
import {
  ADD_EMAIL_TTL_MS,
  PASSWORD_RESET_TTL_MS,
  rateLimiter,
  getClientIp,
  emailsByUserId,
  emailByNormalizedEmail,
  buildLink,
  sendChallengeEmail,
} from "./helpers.ts";
import {
  validateEmailFormat,
  vChallengePurposeArg,
  vPurposeKind,
  startChallengeUserError,
  completeChallengeUserError,
  vEmailSenderConfig,
  normalizeEmail,
  generateRandomToken,
  vChallengeStatus,
  type ChallengeStatus,
} from "./validation.ts";

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
 * Start a challenge: check the address, consume the rate limits,
 * store the hashed code + secret, and send the email.
 *
 * The emailed link carries the code; the returned secret stays in the
 * starting browser. Completion requires both, so a person who only sees the
 * email (or only sees the database) cannot complete the flow.
 *
 * `url` is the landing page the link points at; the code is appended as the
 * `code` query parameter. The caller controls this value — do not pass
 * client-supplied URLs, or the email becomes a phishing vector from a
 * legitimate sender.
 */
export const start = mutation({
  args: {
    email: v.string(),
    purpose: vChallengePurposeArg,
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

    // Purpose-specific checks resolve the user the flow is for.
    const existing = await emailByNormalizedEmail(ctx, normalizedEmail);
    let userId: string;
    if (args.purpose.kind === "passwordReset") {
      if (existing === null) {
        return { success: false, userError: { error: "EMAIL_NOT_FOUND" } };
      }
      userId = existing.userId;
    } else {
      // TODO: let the caller disable this check. It tells the caller if an
      // address has an account, which an app that must prevent user
      // enumeration does not want to reveal before the link is opened.
      if (existing !== null) {
        return { success: false, userError: { error: "EMAIL_TAKEN" } };
      }
      userId = args.purpose.userId;
    }

    const code = generateRandomToken();
    const secret = generateRandomToken();
    const ttl =
      args.purpose.kind === "passwordReset"
        ? PASSWORD_RESET_TTL_MS
        : ADD_EMAIL_TTL_MS;
    await ctx.db.insert("challenges", {
      email,
      normalizedEmail,
      userId,
      purpose: { kind: args.purpose.kind },
      codeHash: await sha256Hex(code),
      secretHash: await sha256Hex(secret),
      expiresAt: Date.now() + ttl,
    });

    await sendChallengeEmail(
      ctx,
      args.emailSender,
      email,
      args.purpose.kind,
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
    // For `setPrimaryEmail`: the address that was primary before this completion
    // replaced it, or `null` when there was none. Callers use it to notify
    // the old address.
    previousPrimaryEmail: v.union(v.string(), v.null()),
  }),
  v.object({
    success: v.literal(false),
    userError: completeChallengeUserError,
  }),
);
type CompleteChallengeResult = Infer<typeof completeChallengeResult>;

/**
 * Complete a challenge with the code from the link and the secret
 * from the starting browser.
 *
 * The claim is one-shot: the row is deleted as soon as the code matches,
 * even when the secret is wrong or the link has expired, so a link can
 * never be replayed. An unknown code, a wrong secret, an expired link and a
 * purpose mismatch all return the same `INVALID_LINK` error.
 *
 * For `addEmail` and `setPrimaryEmail`, completion records the address (see
 * `vChallengePurposeArg` for the primary rules); `setPrimaryEmail` also returns
 * the previous primary address when it replaced one. For `passwordReset`,
 * completion writes nothing and returns the `userId` as the ownership
 * proof.
 */
export const complete = mutation({
  args: {
    code: v.string(),
    secret: v.string(),
    purpose: vPurposeKind,
  },
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
      row.expiresAt < Date.now() ||
      row.purpose.kind !== args.purpose
    ) {
      return { success: false, userError: { error: "INVALID_LINK" } };
    }

    if (row.purpose.kind === "passwordReset") {
      // The proof is only valid while the address is still verified on the
      // same account.
      const verified = await emailByNormalizedEmail(ctx, row.normalizedEmail);
      if (verified === null || verified.userId !== row.userId) {
        return { success: false, userError: { error: "INVALID_LINK" } };
      }
      return {
        success: true,
        userId: row.userId,
        email: row.email,
        previousPrimaryEmail: null,
      };
    }

    // addEmail and setPrimaryEmail: the address must still be free.
    const taken = await emailByNormalizedEmail(ctx, row.normalizedEmail);
    if (taken !== null) {
      return { success: false, userError: { error: "EMAIL_TAKEN" } };
    }

    let previousPrimaryEmail: string | null = null;
    let isPrimary: boolean;
    if (row.purpose.kind === "setPrimaryEmail") {
      // Replace the old primary address. For a first email (sign-up) there
      // is nothing to replace; for a change-email flow the old address is
      // removed from the account.
      const oldPrimary = await ctx.db
        .query("verifiedEmails")
        .withIndex("by_userId_isPrimary", (q) =>
          q.eq("userId", row.userId).eq("isPrimary", true),
        )
        .unique();
      if (oldPrimary !== null) {
        previousPrimaryEmail = oldPrimary.email;
        await ctx.db.delete("verifiedEmails", oldPrimary._id);
      }
      isPrimary = true;
    } else {
      // The first address of a user always becomes primary.
      isPrimary = (await emailsByUserId(ctx, row.userId)).length === 0;
    }
    await ctx.db.insert("verifiedEmails", {
      email: row.email,
      normalizedEmail: row.normalizedEmail,
      userId: row.userId,
      isPrimary,
    });

    return {
      success: true,
      userId: row.userId,
      email: row.email,
      previousPrimaryEmail,
    };
  },
});

/**
 * Report the state of a challenge without claiming it.
 *
 * Landing pages call this to show what the link will do (and to which
 * address) before the user confirms. The checks are the same as
 * `challenge.complete`, including the secret, so a person who only has the
 * link learns nothing.
 */
export const getStatus = query({
  args: { code: v.string(), secret: v.string() },
  returns: vChallengeStatus,
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
    return { status: "pending", purpose: row.purpose.kind, email: row.email };
  },
});
