// The `custom` challenge: prove that the person who started the flow
// controls an address, for a purpose that the application defines. Examples:
// account recovery, a magic link, or a new authentication before a dangerous
// action. Completion writes nothing to the component.
//
// The `purpose` string is opaque to the component. The caller gives the same
// string at start and at completion; a different string fails. Give each purpose a name that another library or flow does not
// use, for example `"myApp/reauthenticate"`.

import { Infer, v } from "convex/values";
import { mutation } from "../_generated/server.ts";
import {
  CUSTOM_TTL_DEFAULT_MS,
  CUSTOM_TTL_MAX_MS,
  CUSTOM_TTL_MIN_MS,
} from "../helpers.ts";
import { startChallengeUserError } from "../validation.ts";
import {
  vStartArgs,
  vClaimArgs,
  startChallengeResult,
  completeChallengeFailure,
  startPreconditions,
  createChallenge,
  claimChallenge,
  type StartChallengeResult,
} from "./common.ts";

const vPurpose = {
  // The application's name for the flow. Opaque to the component.
  purpose: v.string(),
  // The user that the caller asserts owns the flow, or `null` when no user
  // is signed in (for example, account recovery). The component only stores
  // this value and gives it back at completion: it does NOT verify that the
  // user owns the address. A flow that gives access to an account must check
  // itself, after `complete`, that the address is verified for that account.
  userId: v.union(v.string(), v.null()),
};

/**
 * Tell whether `start` would fail with a `userError` for this address,
 * without consuming the rate limits.
 *
 * An application that must write before it calls `start` (for example,
 * create the user) calls `check` first and stops on an error, so the write
 * is not committed when the flow cannot start. When `check` passes, a
 * `start` in the same mutation does not return a `userError`: both run in
 * one transaction, so the limits cannot change in between.
 */
export const check = mutation({
  args: { email: v.string() },
  returns: v.union(startChallengeUserError, v.null()),
  handler: (ctx, { email }) => startPreconditions(ctx, email, "check"),
});

/**
 * Start a `custom` challenge.
 *
 * `subject` and `intro` are the first lines of the email; the component
 * appends the link and the expiry. `ttlMs` bounds how long the link works;
 * it must stay between `CUSTOM_TTL_MIN_MS` and `CUSTOM_TTL_MAX_MS`. A value
 * outside these bounds is a programming error and throws.
 */
export const start = mutation({
  args: {
    ...vStartArgs,
    ...vPurpose,
    subject: v.string(),
    intro: v.string(),
    ttlMs: v.optional(v.number()),
  },
  returns: startChallengeResult,
  handler: async (ctx, args): Promise<StartChallengeResult> => {
    const ttlMs = args.ttlMs ?? CUSTOM_TTL_DEFAULT_MS;
    if (
      !Number.isFinite(ttlMs) ||
      ttlMs < CUSTOM_TTL_MIN_MS ||
      ttlMs > CUSTOM_TTL_MAX_MS
    ) {
      throw new Error(
        `ttlMs must be between ${CUSTOM_TTL_MIN_MS} and ${CUSTOM_TTL_MAX_MS}, ` +
          `got ${ttlMs}`,
      );
    }
    const error = await startPreconditions(ctx, args.email, "consume");
    if (error !== null) {
      return { success: false, userError: error };
    }
    const created = await createChallenge(ctx, {
      email: args.email,
      purpose: { kind: "custom", userId: args.userId, purpose: args.purpose },
      ttlMs,
      url: args.url,
      emailSender: args.emailSender,
      copy: { subject: args.subject, intro: args.intro },
    });
    return { success: true, ...created };
  },
});

const completeResult = v.union(
  v.object({
    success: v.literal(true),
    // The `userId` that the caller gave at start. Not verified: see `start`.
    userId: v.union(v.string(), v.null()),
    email: v.string(),
  }),
  completeChallengeFailure,
);
type CompleteResult = Infer<typeof completeResult>;

/**
 * Complete a `custom` challenge. The `purpose` and the `userId` must be the
 * ones given at start.
 */
export const complete = mutation({
  args: { ...vClaimArgs, ...vPurpose },
  returns: completeResult,
  handler: async (ctx, args): Promise<CompleteResult> => {
    const claim = await claimChallenge(ctx, {
      emailCode: args.emailCode,
      browserSecret: args.browserSecret,
      purpose: { kind: "custom", userId: args.userId, purpose: args.purpose },
    });
    if (!claim.success) {
      return claim.failure;
    }
    return { success: true, userId: args.userId, email: claim.row.email };
  },
});
