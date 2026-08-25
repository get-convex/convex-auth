// The `setPrimaryEmail` challenge: prove that an address belongs to
// `userId`, then make it the primary address of the user. The previous
// primary address is removed from the account. For apps where each user has
// one email address.

import { Infer, v } from "convex/values";
import { mutation, query } from "../_generated/server.ts";
import { ADD_EMAIL_TTL_MS, VALIDATE_EMAIL_COPY } from "../helpers.ts";
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

const PURPOSE = { kind: "setPrimaryEmail" } as const;

/**
 * Start a `setPrimaryEmail` challenge for `userId`. Fails with `EMAIL_TAKEN`
 * when a user has already verified the address.
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
    // The address that was primary before this completion replaced it, or
    // `null` when there was none. Callers use it to notify the old address.
    previousPrimaryEmail: v.union(v.string(), v.null()),
  }),
  completeChallengeFailure,
);
type CompleteResult = Infer<typeof completeResult>;

/**
 * Complete a `setPrimaryEmail` challenge: remove the old primary address and
 * record the new one as primary. Fails with `EMAIL_TAKEN` when another user
 * verified the address after the start.
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
    // For a first email there is nothing to replace; for a change-email flow
    // the old address is removed from the account.
    const oldPrimary = await ctx.db
      .query("verifiedEmails")
      .withIndex("by_userId_isPrimary", (q) =>
        q.eq("userId", userId).eq("isPrimary", true),
      )
      .unique();
    let previousPrimaryEmail: string | null = null;
    if (oldPrimary !== null) {
      previousPrimaryEmail = oldPrimary.email;
      await ctx.db.delete("verifiedEmails", oldPrimary._id);
    }
    await ctx.db.insert("verifiedEmails", {
      email: row.email,
      normalizedEmail: row.normalizedEmail,
      userId,
      isPrimary: true,
    });
    return {
      success: true,
      userId,
      email: row.email,
      previousPrimaryEmail,
    };
  },
});

/** Report the state of a `setPrimaryEmail` challenge without claiming it. */
export const getStatus = query({
  args: vClaimArgs,
  returns: vChallengeStatus,
  handler: async (ctx, args): Promise<ChallengeStatus> =>
    await getChallengeStatus(ctx, { ...args, purpose: PURPOSE }),
});
