import { mutation, query } from "./_generated/server.ts";
import { Infer, v } from "convex/values";
import { sha256Hex } from "../../lib/crypto.ts";
import {
  DEFAULT_CHALLENGE_TTL_MS,
  rateLimiter,
  getClientIp,
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
import { scheduleChallengeSweep } from "./sweep.ts";

// A challenge proves that the person who started it owns an email address.
// The component does not know what the caller does with that fact: the
// `purpose` is an opaque string, and completion returns a proof that the
// caller can spend with `verifiedEmails.add`, or not spend at all (account
// recovery, re-authentication before a sensitive action).

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
 * Start a challenge: check the address format, consume the rate limits,
 * store the hashed code + secret, and send the email.
 *
 * The emailed link carries the code; the returned secret stays in the
 * starting browser. Completion requires both, so a person who only sees the
 * email (or only sees the database) cannot complete the flow.
 *
 * - `purpose` is opaque to the component. `challenge.complete` requires the
 *   same value, so a link sent for one flow cannot complete another. The
 *   value is also what `challenge.getStatus` reports to landing pages.
 * - `userId` binds the challenge to a user. Give it when the proof will be
 *   spent with `verifiedEmails.add` (the address becomes that user's), or
 *   when the flow re-authenticates a signed-in user. Leave it out for
 *   account recovery, where the caller identifies the user from the address
 *   afterwards (`verifiedEmails.getUserIdByEmail`).
 * - `ttlMs` is how long the link stays valid. Defaults to one hour.
 * - `url` is the landing page the link points at; the code is appended as
 *   the `code` query parameter. The caller controls this value — do not pass
 *   client-supplied URLs, or the email becomes a phishing vector from a
 *   legitimate sender.
 *
 * The component does not check the address against `verifiedEmails` here:
 * whether the address must be free (adding an email) or must already be
 * verified (recovery) depends on the purpose, which only the caller knows.
 * `verifiedEmails.add` rejects an address that is taken when the proof is
 * spent.
 */
export const start = mutation({
  args: {
    email: v.string(),
    purpose: v.string(),
    userId: v.optional(v.string()),
    url: v.string(),
    emailSender: vEmailSenderConfig,
    ttlMs: v.optional(v.number()),
  },
  returns: startChallengeResult,
  handler: async (ctx, args): Promise<StartChallengeResult> => {
    const formatError = validateEmailFormat(args.email);
    if (formatError !== null) {
      return { success: false, userError: formatError };
    }
    // `email` keeps the case the user gave: the link goes to that address and
    // a spent proof records it. The rate limit key is the normalized form.
    const email = args.email;

    // Consume both rate limits. A failure after `challenge.checkStart`
    // passed in the same mutation is unexpected (same transaction), so
    // callers that pre-checked treat the `RATE_LIMITED` arm as unreachable.
    const ip = await getClientIp(ctx);
    const perEmail = await rateLimiter.limit(ctx, "startChallengePerEmail", {
      key: normalizeEmail(email),
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

    const code = generateRandomToken();
    const secret = generateRandomToken();
    const ttlMs = args.ttlMs ?? DEFAULT_CHALLENGE_TTL_MS;
    await ctx.db.insert("challenges", {
      email,
      userId: args.userId,
      purpose: args.purpose,
      codeHash: await sha256Hex(code),
      secretHash: await sha256Hex(secret),
      expiresAt: Date.now() + ttlMs,
    });

    await sendChallengeEmail(
      ctx,
      args.emailSender,
      email,
      buildLink(args.url, code),
      ttlMs,
    );
    // The row expires at `expiresAt`; make sure the loop that deletes expired
    // rows is running.
    await scheduleChallengeSweep(ctx);

    return { success: true, secret };
  },
});

const completeChallengeResult = v.union(
  v.object({
    success: v.literal(true),
    // The address, with the case that the user gave at start.
    email: v.string(),
    // The user given to `challenge.start`, or `null` when there was none.
    userId: v.union(v.string(), v.null()),
    purpose: v.string(),
    // The ownership proof. Spend it with `verifiedEmails.add` in the same
    // mutation to record the address for `userId`. It is a 256-bit random
    // token that only this completion knows; it cannot be constructed.
    proof: v.string(),
  }),
  v.object({
    success: v.literal(false),
    userError: completeChallengeUserError,
  }),
);
type CompleteChallengeResult = Infer<typeof completeChallengeResult>;

/**
 * Complete a challenge with the code from the link and the secret from the
 * starting browser.
 *
 * The claim is one-shot: the first call that finds the row decides its fate.
 * On success the row is marked completed and the returned `proof` is the
 * only way to act on it. On any failure the row is deleted, so a link can
 * never be replayed. An unknown code, a wrong secret, an expired link, a
 * purpose mismatch and an already completed challenge all return the same
 * `INVALID_LINK` error.
 *
 * Completion writes nothing to `verifiedEmails`. To record the address for
 * the bound user, pass `proof` to `verifiedEmails.add` in the same mutation.
 * For recovery or re-authentication, the returned `email` and `userId` are
 * the result; the proof stays unspent and the sweep loop deletes the row
 * after the mutation commits. A proof cannot be spent from a later mutation.
 */
export const complete = mutation({
  args: {
    code: v.string(),
    secret: v.string(),
    purpose: v.string(),
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
    if (
      row.proofHash !== undefined ||
      row.secretHash !== (await sha256Hex(args.secret)) ||
      row.expiresAt < Date.now() ||
      row.purpose !== args.purpose
    ) {
      // A raced or replayed completion must find nothing.
      await ctx.db.delete("challenges", row._id);
      return { success: false, userError: { error: "INVALID_LINK" } };
    }

    const proof = generateRandomToken();
    await ctx.db.patch("challenges", row._id, {
      proofHash: await sha256Hex(proof),
      completedAt: Date.now(),
    });
    // The sweep loop deletes this row after the mutation commits, unless
    // `verifiedEmails.add` spends the proof first in the same mutation.
    await scheduleChallengeSweep(ctx);
    return {
      success: true,
      email: row.email,
      userId: row.userId ?? null,
      purpose: row.purpose,
      proof,
    };
  },
});

const challengeStatus = v.union(
  v.object({
    status: v.literal("pending"),
    purpose: v.string(),
    email: v.string(),
  }),
  v.object({ status: v.literal("invalid") }),
);
type ChallengeStatus = Infer<typeof challengeStatus>;

/**
 * Report the state of a challenge without claiming it.
 *
 * Landing pages call this to show what the link will do (and to which
 * address) before the user confirms. The checks are the same as
 * `challenge.complete`, including the secret, so a person who only has the
 * link learns nothing. A completed challenge reports `invalid`.
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
      row.proofHash !== undefined ||
      row.secretHash !== (await sha256Hex(args.secret)) ||
      row.expiresAt < Date.now()
    ) {
      return { status: "invalid" };
    }
    return { status: "pending", purpose: row.purpose, email: row.email };
  },
});
