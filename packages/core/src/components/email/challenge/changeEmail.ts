// The `changeEmail` challenge: prove that an address belongs to
// `userId`, then make it the primary address of the user. The previous
// primary address is removed from the account. For apps where each user has
// one email address.

import { Infer, v } from "convex/values";
import { mutation } from "../_generated/server.ts";
import { ADD_EMAIL_TTL_MS, VALIDATE_EMAIL_COPY } from "../helpers.ts";
import { normalizeEmail, startFreeAddressUserError } from "../validation.ts";
import {
  vStartArgs,
  vClaimArgs,
  startFreeAddressResult,
  completeFreeAddressFailure,
  startFreeAddressPreconditions,
  addressTakenError,
  createChallengeAndSendEmail,
  claimChallenge,
  type StartFreeAddressResult,
} from "./common.ts";

/**
 * Tell whether `start` would fail with a `userError` for this address,
 * without consuming the rate limits. See `custom.check`.
 */
export const check = mutation({
  args: { email: v.string() },
  returns: v.union(startFreeAddressUserError, v.null()),
  handler: (ctx, { email }) =>
    startFreeAddressPreconditions(ctx, email, "check"),
});

/**
 * Start a `changeEmail` challenge for `userId`. Fails with `EMAIL_TAKEN`
 * when a user has already verified the address.
 */
export const start = mutation({
  args: { ...vStartArgs, userId: v.string() },
  returns: startFreeAddressResult,
  handler: async (ctx, args): Promise<StartFreeAddressResult> => {
    const error = await startFreeAddressPreconditions(
      ctx,
      args.email,
      "consume",
    );
    if (error !== null) {
      return { success: false, userError: error };
    }
    const created = await createChallengeAndSendEmail(ctx, {
      email: args.email,
      purpose: { kind: "changeEmail", userId: args.userId },
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
    previousEmail: v.union(v.string(), v.null()),
  }),
  completeFreeAddressFailure,
);
type CompleteResult = Infer<typeof completeResult>;

/**
 * Complete a `changeEmail` challenge: remove the old primary address and
 * record the new one as primary. The `userId` must be the one given at
 * start. Fails with `EMAIL_TAKEN` when another user verified the address
 * after the start.
 */
export const complete = mutation({
  args: { ...vClaimArgs, userId: v.string() },
  returns: completeResult,
  handler: async (ctx, args): Promise<CompleteResult> => {
    const { userId } = args;
    const claim = await claimChallenge(ctx, {
      emailCode: args.emailCode,
      browserSecret: args.browserSecret,
      purpose: { kind: "changeEmail", userId },
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
    // For a first email there is nothing to replace; for a change-email flow
    // the old address is removed from the account.
    const oldPrimary = await ctx.db
      .query("verifiedEmails")
      .withIndex("by_userId_isPrimary", (q) =>
        q.eq("userId", userId).eq("isPrimary", true),
      )
      .unique();
    let previousEmail: string | null = null;
    if (oldPrimary !== null) {
      previousEmail = oldPrimary.email;
      await ctx.db.delete("verifiedEmails", oldPrimary._id);
    }
    await ctx.db.insert("verifiedEmails", {
      email: row.email,
      normalizedEmail,
      userId,
      isPrimary: true,
    });
    return {
      success: true,
      userId,
      email: row.email,
      previousEmail,
    };
  },
});
