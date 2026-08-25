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
import {
  normalizeEmail,
  vChallengeStatus,
  type ChallengeStatus,
} from "../validation.ts";
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
      purpose: { kind: "addEmail", userId: args.userId },
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
 * Complete an `addEmail` challenge: record the address for the user. The
 * `userId` must be the one given at start. Fails with `EMAIL_TAKEN` when
 * another user verified the address after the start.
 */
export const complete = mutation({
  args: { ...vClaimArgs, userId: v.string() },
  returns: completeResult,
  handler: async (ctx, args): Promise<CompleteResult> => {
    const { userId } = args;
    const row = await claimChallenge(ctx, {
      code: args.code,
      secret: args.secret,
      purpose: { kind: "addEmail", userId },
    });
    if (row === null) {
      return INVALID_LINK;
    }
    const normalizedEmail = normalizeEmail(row.email);
    const taken = await addressTakenError(ctx, normalizedEmail);
    if (taken !== null) {
      return { success: false, userError: taken };
    }
    // The first address of a user always becomes primary.
    const isPrimary = (await emailsByUserId(ctx, userId)).length === 0;
    await ctx.db.insert("verifiedEmails", {
      email: row.email,
      normalizedEmail,
      userId,
      isPrimary,
    });
    return { success: true, userId, email: row.email };
  },
});

/** Report the state of an `addEmail` challenge without claiming it. */
export const getStatus = query({
  args: { ...vClaimArgs, userId: v.string() },
  returns: vChallengeStatus,
  handler: async (ctx, args): Promise<ChallengeStatus> =>
    await getChallengeStatus(ctx, {
      code: args.code,
      secret: args.secret,
      purpose: { kind: "addEmail", userId: args.userId },
    }),
});
