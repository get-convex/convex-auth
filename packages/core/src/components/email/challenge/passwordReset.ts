// The `passwordReset` challenge: prove that the person owns an address that
// is already verified on an account. Completion writes nothing; it returns
// the `userId` of the account as the ownership proof.

import { Infer, v } from "convex/values";
import { mutation, query } from "../_generated/server.ts";
import { PASSWORD_RESET_TTL_MS, emailByNormalizedEmail } from "../helpers.ts";
import { vChallengeStatus, type ChallengeStatus } from "../validation.ts";
import {
  vStartArgs,
  vClaimArgs,
  startChallengeResult,
  completeChallengeFailure,
  INVALID_LINK,
  prepareStart,
  createChallenge,
  claimChallenge,
  getChallengeStatus,
  type StartChallengeResult,
} from "./common.ts";

const PURPOSE = { kind: "passwordReset" } as const;

/**
 * Start a `passwordReset` challenge for the account that verified the
 * address. Fails with `EMAIL_NOT_FOUND` when no account did.
 */
export const start = mutation({
  args: vStartArgs,
  returns: startChallengeResult,
  handler: async (ctx, args): Promise<StartChallengeResult> => {
    const prepared = await prepareStart(ctx, args.email);
    if (!prepared.ok) {
      return { success: false, userError: prepared.userError };
    }
    const existing = await emailByNormalizedEmail(
      ctx,
      prepared.normalizedEmail,
    );
    if (existing === null) {
      return { success: false, userError: { error: "EMAIL_NOT_FOUND" } };
    }
    const secret = await createChallenge(ctx, {
      email: prepared.email,
      normalizedEmail: prepared.normalizedEmail,
      userId: existing.userId,
      purpose: PURPOSE,
      ttlMs: PASSWORD_RESET_TTL_MS,
      url: args.url,
      emailSender: args.emailSender,
    });
    return { success: true, secret };
  },
});

const completeResult = v.union(
  v.object({
    success: v.literal(true),
    userId: v.string(),
    email: v.string(),
  }),
  completeChallengeFailure,
);
type CompleteResult = Infer<typeof completeResult>;

/**
 * Complete a `passwordReset` challenge. The proof is only valid while the
 * address is still verified on the same account.
 */
export const complete = mutation({
  args: vClaimArgs,
  returns: completeResult,
  handler: async (ctx, args): Promise<CompleteResult> => {
    const row = await claimChallenge(ctx, { ...args, purpose: PURPOSE });
    if (row === null) {
      return INVALID_LINK;
    }
    const verified = await emailByNormalizedEmail(ctx, row.normalizedEmail);
    if (verified === null || verified.userId !== row.userId) {
      return INVALID_LINK;
    }
    return { success: true, userId: row.userId, email: row.email };
  },
});

/** Report the state of a `passwordReset` challenge without claiming it. */
export const getStatus = query({
  args: vClaimArgs,
  returns: vChallengeStatus,
  handler: async (ctx, args): Promise<ChallengeStatus> =>
    await getChallengeStatus(ctx, { ...args, purpose: PURPOSE }),
});
