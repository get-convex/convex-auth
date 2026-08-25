// The `addEmail` challenge: prove that an address belongs to `userId`, then
// record it as an email address of the user. The first address of a user
// becomes primary; a later address is secondary.

import { Infer, v } from "convex/values";
import { mutation } from "../_generated/server.ts";
import {
  ADD_EMAIL_TTL_MS,
  VALIDATE_EMAIL_COPY,
  emailsByUserId,
} from "../helpers.ts";
import { normalizeEmail, startChallengeUserError } from "../validation.ts";
import {
  vStartArgs,
  vClaimArgs,
  startChallengeResult,
  completeChallengeFailure,
  startFreeAddressPreconditions,
  addressTakenError,
  createChallenge,
  claimChallenge,
  type StartChallengeResult,
} from "./common.ts";

/**
 * Tell whether `start` would fail with a `userError` for this address,
 * without consuming the rate limits. See `custom.check`.
 */
export const check = mutation({
  args: { email: v.string() },
  returns: v.union(startChallengeUserError, v.null()),
  handler: (ctx, { email }) =>
    startFreeAddressPreconditions(ctx, email, "check"),
});

/**
 * Start an `addEmail` challenge for `userId`. Fails with `EMAIL_TAKEN` when
 * a user has already verified the address.
 */
export const start = mutation({
  args: { ...vStartArgs, userId: v.string() },
  returns: startChallengeResult,
  handler: async (ctx, args): Promise<StartChallengeResult> => {
    const error = await startFreeAddressPreconditions(
      ctx,
      args.email,
      "consume",
    );
    if (error !== null) {
      return { success: false, userError: error };
    }
    const created = await createChallenge(ctx, {
      email: args.email,
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
    const claim = await claimChallenge(ctx, {
      emailCode: args.emailCode,
      browserSecret: args.browserSecret,
      purpose: { kind: "addEmail", userId },
    });
    if (!claim.success) {
      return claim.failure;
    }
    const { row } = claim;
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
