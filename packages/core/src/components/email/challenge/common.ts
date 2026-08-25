// Server-only code that the challenge kinds share. Each kind lives in its
// own file (`addEmail.ts`, `setPrimaryEmail.ts`, `passwordReset.ts`) and
// exposes `start`, `complete` and `getStatus`. The kind of a challenge is
// the function that the caller uses: there is no purpose argument.

import { Infer, v } from "convex/values";
import type { MutationCtx, QueryCtx } from "../_generated/server.ts";
import type { Doc } from "../_generated/dataModel.ts";
import { sha256Hex } from "../../../lib/crypto.ts";
import {
  rateLimiter,
  getClientIp,
  emailByNormalizedEmail,
  buildLink,
  sendChallengeEmail,
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
  // a completion records it. `normalizedEmail` is the lookup key.
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
 * Return `EMAIL_TAKEN` when a user has already verified the address, or
 * `null` when the address is free. The kinds that record an address call
 * this at start and again at completion.
 *
 * TODO: let the caller disable this check at start. It tells the caller if
 * an address has an account, which an app that must prevent user
 * enumeration does not want to reveal before the link is opened.
 */
export async function addressTakenError(
  ctx: QueryCtx,
  normalizedEmail: string,
): Promise<{ error: "EMAIL_TAKEN" } | null> {
  const existing = await emailByNormalizedEmail(ctx, normalizedEmail);
  return existing === null ? null : { error: "EMAIL_TAKEN" };
}

/**
 * Store the hashed code + secret and send the email. Returns the secret that
 * the starting browser keeps.
 */
export async function createChallenge(
  ctx: MutationCtx,
  args: {
    email: string;
    normalizedEmail: string;
    userId: string;
    purpose: ChallengePurpose;
    ttlMs: number;
    url: string;
    emailSender: EmailSenderConfig;
  },
): Promise<string> {
  const code = generateRandomToken();
  const secret = generateRandomToken();
  await ctx.db.insert("challenges", {
    email: args.email,
    normalizedEmail: args.normalizedEmail,
    userId: args.userId,
    purpose: args.purpose,
    codeHash: await sha256Hex(code),
    secretHash: await sha256Hex(secret),
    expiresAt: Date.now() + args.ttlMs,
  });
  await sendChallengeEmail(
    ctx,
    args.emailSender,
    args.email,
    args.purpose.kind,
    buildLink(args.url, code),
  );
  return secret;
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
  return a.kind === b.kind;
}

/**
 * Tell whether the row can be claimed with these credentials. A wrong
 * secret, an expired link and a purpose mismatch all fail the same way, so
 * the response is not an oracle for attackers.
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
 * not match, so a link can never be replayed. A purpose mismatch is an
 * application bug (the landing page called the wrong kind); the link is
 * burned anyway, out of safety.
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
