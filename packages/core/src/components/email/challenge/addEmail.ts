// The `addEmail` challenge: prove that an address belongs to `userId`, then
// record it as an email address of the user. The first address of a user
// becomes primary; a later address is secondary.

import { Infer, v } from "convex/values";
import { mutation } from "../_generated/server.ts";
import {
  ADD_EMAIL_TTL_MS,
  VALIDATE_EMAIL_COPY,
  userHasEmail,
} from "../helpers.ts";
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
 * Start an `addEmail` challenge for `userId`. Fails with `EMAIL_TAKEN` when
 * a user has already verified the address.
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
  completeFreeAddressFailure,
);
type CompleteResult = Infer<typeof completeResult>;

/**
 * Complete an `addEmail` challenge: record the address for the user. When the
 * caller gives a `userId`, it must be the one given at start. A caller with
 * no session (sign-up) leaves it out, and the user is the one from the start.
 * Fails with `EMAIL_TAKEN` when another user verified the address after the
 * start.
 */
export const complete = mutation({
  args: { ...vClaimArgs, userId: v.optional(v.string()) },
  returns: completeResult,
  handler: async (ctx, args): Promise<CompleteResult> => {
    const claim = await claimChallenge(ctx, {
      emailCode: args.emailCode,
      browserSecret: args.browserSecret,
      purpose:
        args.userId === undefined
          ? { kind: "addEmail" }
          : { kind: "addEmail", userId: args.userId },
    });
    if (!claim.success) {
      return claim.failure;
    }
    const { row } = claim;
    if (row.purpose.kind !== "addEmail") {
      throw new Error("Unreachable: the claim checked the purpose kind");
    }
    const { userId } = row.purpose;
    const normalizedEmail = normalizeEmail(row.email);
    const taken = await addressTakenError(ctx, normalizedEmail);
    if (taken !== null) {
      return { success: false, userError: taken };
    }
    // The first address of a user always becomes primary.
    const isPrimary = !(await userHasEmail(ctx, userId));
    await ctx.db.insert("verifiedEmails", {
      email: row.email,
      normalizedEmail,
      userId,
      isPrimary,
    });
    return { success: true, userId, email: row.email };
  },
});
