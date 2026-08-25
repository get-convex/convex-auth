// Server-only code that the challenge kinds share. Each kind lives in its
// own file in this directory and exposes `start`, `complete` and
// `getStatus`. The kind of a challenge is the function that the caller uses.

import { Infer, v } from "convex/values";
import type { MutationCtx, QueryCtx } from "../_generated/server.ts";
import type { Doc, Id } from "../_generated/dataModel.ts";
import { sha256Hex } from "../../../lib/crypto.ts";
import {
  rateLimiter,
  getClientIp,
  buildLink,
  sendChallengeEmail,
  type ChallengeEmailCopy,
} from "../helpers.ts";
import {
  validateEmailFormat,
  normalizeEmail,
  generateRandomToken,
  startChallengeUserError,
  completeChallengeUserError,
  vEmailSenderConfig,
  type StartChallengeUserError,
  type EmailSenderConfig,
  type ChallengeStatus,
} from "../validation.ts";

export type ChallengePurpose = Doc<"challenges">["purpose"];

// --- Shared validators -----------------------------------------------------

/** The arguments that every `start` mutation accepts. */
export const vStartArgs = {
  email: v.string(),
  // The landing page the link points at; the code is appended as the `code`
  // query parameter. The caller controls this value — do not pass
  // client-supplied URLs, or the email becomes a phishing vector from a
  // legitimate sender.
  url: v.string(),
  emailSender: vEmailSenderConfig,
};

/** The arguments that every `complete` mutation and `getStatus` query accept. */
export const vClaimArgs = {
  // The code from the emailed link.
  code: v.string(),
  // The secret that the starting browser kept.
  secret: v.string(),
};

export const startChallengeResult = v.union(
  v.object({
    success: v.literal(true),
    // The secret the client must keep (in its local storage) and present
    // again at completion. It never travels in the email.
    secret: v.string(),
    // The new challenge. A caller that must keep data about the flow can
    // store it in its own table, keyed by this ID.
    challengeId: v.id("challenges"),
  }),
  v.object({ success: v.literal(false), userError: startChallengeUserError }),
);
export type StartChallengeResult = Infer<typeof startChallengeResult>;

export const completeChallengeFailure = v.object({
  success: v.literal(false),
  userError: completeChallengeUserError,
});

export const INVALID_LINK = {
  success: false,
  userError: { error: "INVALID_LINK" },
} as const;

// --- Start ------------------------------------------------------------------

export type PreparedStart =
  | { ok: true; email: string; normalizedEmail: string }
  | { ok: false; userError: StartChallengeUserError };

/**
 * The first steps of every `start`: check the address format, then consume
 * both rate limits.
 *
 * A limit failure after `rateLimit.checkStart` passed in the same mutation is
 * unexpected (same transaction), so callers that pre-checked treat the
 * `RATE_LIMITED` arm as unreachable.
 */
export async function prepareStart(
  ctx: MutationCtx,
  email: string,
): Promise<PreparedStart> {
  const formatError = validateEmailFormat(email);
  if (formatError !== null) {
    return { ok: false, userError: formatError };
  }
  // `email` keeps the case the user gave: the link goes to that address and
  // a completion records it. The normalized form is the key for the rate
  // limit and for the lookups in `verifiedEmails`.
  const normalizedEmail = normalizeEmail(email);

  const ip = await getClientIp(ctx);
  const perEmail = await rateLimiter.limit(ctx, "startChallengePerEmail", {
    key: normalizedEmail,
  });
  if (!perEmail.ok) {
    return {
      ok: false,
      userError: { error: "RATE_LIMITED", retryAfterMs: perEmail.retryAfter },
    };
  }
  const perIp = await rateLimiter.limit(ctx, "startChallengePerIp", {
    key: ip,
  });
  if (!perIp.ok) {
    return {
      ok: false,
      userError: { error: "RATE_LIMITED", retryAfterMs: perIp.retryAfter },
    };
  }
  return { ok: true, email, normalizedEmail };
}

/**
 * Store the hashed code + secret and send the email. Returns the secret that
 * the starting browser keeps, and the ID of the new row.
 */
export async function createChallenge(
  ctx: MutationCtx,
  args: {
    email: string;
    purpose: ChallengePurpose;
    ttlMs: number;
    url: string;
    emailSender: EmailSenderConfig;
    copy: ChallengeEmailCopy;
  },
): Promise<{ secret: string; challengeId: Id<"challenges"> }> {
  const code = generateRandomToken();
  const secret = generateRandomToken();
  const challengeId = await ctx.db.insert("challenges", {
    email: args.email,
    purpose: args.purpose,
    codeHash: await sha256Hex(code),
    secretHash: await sha256Hex(secret),
    expiresAt: Date.now() + args.ttlMs,
  });
  await sendChallengeEmail(ctx, args.emailSender, {
    to: args.email,
    copy: args.copy,
    link: buildLink(args.url, code),
    ttlMs: args.ttlMs,
  });
  return { secret, challengeId };
}

// --- Complete and status ---------------------------------------------------

async function findByCode(
  ctx: QueryCtx,
  code: string,
): Promise<Doc<"challenges"> | null> {
  const codeHash = await sha256Hex(code);
  return await ctx.db
    .query("challenges")
    .withIndex("by_codeHash", (q) => q.eq("codeHash", codeHash))
    .unique();
}

function samePurpose(a: ChallengePurpose, b: ChallengePurpose): boolean {
  return a.kind === b.kind && a.userId === b.userId;
}

/**
 * Tell whether the row can be claimed with these credentials. The expected
 * purpose carries the `userId` that the caller asserts, so a link can never
 * complete a flow for another user. A wrong secret, an expired link and
 * another purpose all fail the same way, so the response is not an oracle
 * for attackers.
 */
async function matches(
  row: Doc<"challenges">,
  args: { secret: string; purpose: ChallengePurpose },
): Promise<boolean> {
  return (
    row.secretHash === (await sha256Hex(args.secret)) &&
    row.expiresAt >= Date.now() &&
    samePurpose(row.purpose, args.purpose)
  );
}

/**
 * Claim a challenge with the code from the link and the secret from the
 * starting browser. Returns the row, or `null` when the claim fails.
 *
 * The claim is one-shot: the row is deleted as soon as the code matches,
 * even when the secret is wrong, the link has expired or the purpose does
 * not match, so a link can never be replayed. A purpose mismatch (another
 * kind, or another `userId`) is an application bug: the landing page called
 * the wrong function, or gave the wrong user. The link is burned anyway,
 * out of safety.
 */
export async function claimChallenge(
  ctx: MutationCtx,
  args: { code: string; secret: string; purpose: ChallengePurpose },
): Promise<Doc<"challenges"> | null> {
  const row = await findByCode(ctx, args.code);
  if (row === null) {
    return null;
  }
  // One-shot claim: delete before any check, so a raced or replayed
  // completion finds nothing.
  await ctx.db.delete("challenges", row._id);
  return (await matches(row, args)) ? row : null;
}

/**
 * Report the state of a challenge without claiming it. The checks are the
 * same as `claimChallenge`, including the secret, so a person who only has
 * the link learns nothing.
 */
export async function getChallengeStatus(
  ctx: QueryCtx,
  args: { code: string; secret: string; purpose: ChallengePurpose },
): Promise<ChallengeStatus> {
  const row = await findByCode(ctx, args.code);
  if (row === null || !(await matches(row, args))) {
    return { status: "invalid" };
  }
  return { status: "pending", email: row.email };
}
