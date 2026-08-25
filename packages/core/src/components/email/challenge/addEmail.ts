// The `addEmail` challenge: prove that an address belongs to `userId`, then
// record it as an email address of the user. The first address of a user
// becomes primary; a later address is secondary.

import { Infer, v } from "convex/values";
import { mutation, query } from "../_generated/server.ts";
import {
  ADD_EMAIL_TTL_MS,
  VALIDATE_EMAIL_COPY,
  emailsByUserId,
} from "../helpers.ts";
import { vChallengeStatus, type ChallengeStatus } from "../validation.ts";
import {
  vStartArgs,
  vClaimArgs,
  startChallengeResult,
  completeChallengeFailure,
  INVALID_LINK,
  prepareStart,
  addressTakenError,
  createChallenge,
  claimChallenge,
  getChallengeStatus,
  type StartChallengeResult,
} from "./common.ts";

const PURPOSE = { kind: "addEmail" } as const;

/**
 * Start an `addEmail` challenge for `userId`. Fails with `EMAIL_TAKEN` when
 * a user has already verified the address.
 */
export const start = mutation({
  args: { ...vStartArgs, userId: v.string() },
  returns: startChallengeResult,
  handler: async (ctx, args): Promise<StartChallengeResult> => {
    const prepared = await prepareStart(ctx, args.email);
    if (!prepared.ok) {
      return { success: false, userError: prepared.userError };
    }
    const taken = await addressTakenError(ctx, prepared.normalizedEmail);
    if (taken !== null) {
      return { success: false, userError: taken };
    }
    const created = await createChallenge(ctx, {
      email: prepared.email,
      normalizedEmail: prepared.normalizedEmail,
      userId: args.userId,
      purpose: PURPOSE,
      ttlMs: ADD_EMAIL_TTL_MS,
      url: args.url,
      emailSender: args.emailSender,
      copy: VALIDATE_EMAIL_COPY,
    });
    return { success: true, ...created };
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
 * Complete an `addEmail` challenge: record the address for the user. Fails
 * with `EMAIL_TAKEN` when another user verified the address after the start.
 */
export const complete = mutation({
  args: vClaimArgs,
  returns: completeResult,
  handler: async (ctx, args): Promise<CompleteResult> => {
    const row = await claimChallenge(ctx, { ...args, purpose: PURPOSE });
    if (row === null) {
      return INVALID_LINK;
    }
    // A row of this kind always has a user: `start` requires one.
    const userId = row.userId as string;
    const taken = await addressTakenError(ctx, row.normalizedEmail);
    if (taken !== null) {
      return { success: false, userError: taken };
    }
    // The first address of a user always becomes primary.
    const isPrimary = (await emailsByUserId(ctx, userId)).length === 0;
    await ctx.db.insert("verifiedEmails", {
      email: row.email,
      normalizedEmail: row.normalizedEmail,
      userId,
      isPrimary,
    });
    return { success: true, userId, email: row.email };
  },
});

/** Report the state of an `addEmail` challenge without claiming it. */
export const getStatus = query({
  args: vClaimArgs,
  returns: vChallengeStatus,
  handler: async (ctx, args): Promise<ChallengeStatus> =>
    await getChallengeStatus(ctx, { ...args, purpose: PURPOSE }),
});
