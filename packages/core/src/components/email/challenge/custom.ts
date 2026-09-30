// The `custom` challenge: prove that the person who started the flow
// controls an address, for a purpose that the application defines. Examples:
// account recovery, a magic link, or a new verification before a dangerous
// action. Completion writes nothing to the component.
//
// The `purpose` string is opaque to the component. The caller gives the same
// string at start and at completion; a different string fails. Give each purpose a name that another library or flow does not
// use, for example `"myApp/reauthenticate"`.

import { Infer, ObjectType, v } from "convex/values";
import {
  mutation,
  query,
  type MutationCtx,
  type QueryCtx,
} from "../_generated/server.ts";
import {
  CUSTOM_TTL_DEFAULT_MS,
  CUSTOM_TTL_MAX_MS,
  CUSTOM_TTL_MIN_MS,
  getVerifiedEmail,
} from "../helpers.ts";
import {
  completeChallengeUserError,
  wrongUserUserError,
  normalizeEmail,
  startCustomUserError,
  vExpectedOwner,
  type ExpectedOwner,
  type StartCustomUserError,
  type VerbatimEmail,
} from "../validation.ts";
import {
  vStartArgs,
  vClaimArgs,
  startCustomResult,
  startPreconditions,
  preconditionsUserError,
  createChallengeAndSendEmail,
  claimChallenge,
  findClaimableChallenge,
  type ChallengeOfKind,
  type PreconditionsResult,
  type StartCustomResult,
} from "./common.ts";

// The application's name for the flow. Opaque to the component.
const vPurposeName = v.string();

/** Tell whether `emailOwnerId` satisfies `expected`. */
function ownerMatches(
  expected: ExpectedOwner,
  emailOwnerId: string | null,
): boolean {
  switch (expected.kind) {
    case "user":
      return emailOwnerId === expected.userId;
    case "anyUser":
      return emailOwnerId !== null;
    case "anyone":
      return true;
  }
}

/** The user that has `email` as a verified address, or `null`. */
async function emailOwnerIdOf(
  ctx: QueryCtx,
  email: VerbatimEmail,
): Promise<string | null> {
  const verifiedEmail = await getVerifiedEmail(ctx, normalizeEmail(email));
  return verifiedEmail === null ? null : verifiedEmail.userId;
}

/**
 * The `start` preconditions of a `custom` challenge: the shared
 * preconditions, then the owner of the address must satisfy
 * `expectedOwner`. Another owner, or no owner, gives `EMAIL_NOT_FOUND`, thus
 * the caller cannot tell the two cases apart.
 *
 * The owner check runs after the rate limits, on purpose: a free answer
 * would make this an unlimited enumeration oracle.
 */
async function customStartPreconditions(
  ctx: MutationCtx,
  args: { email: string; expectedOwner: ExpectedOwner },
  mode: "check" | "consume",
): Promise<PreconditionsResult<StartCustomUserError>> {
  const result = await startPreconditions(ctx, args.email, mode);
  if (!result.success) {
    return result;
  }
  const emailOwnerId = await emailOwnerIdOf(ctx, result.email);
  if (!ownerMatches(args.expectedOwner, emailOwnerId)) {
    return { success: false, userError: { error: "EMAIL_NOT_FOUND" } };
  }
  return result;
}

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
  args: { email: v.string(), expectedOwner: vExpectedOwner },
  returns: v.union(startCustomUserError, v.null()),
  handler: async (ctx, args) =>
    preconditionsUserError(await customStartPreconditions(ctx, args, "check")),
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
    purpose: vPurposeName,
    // The owner that the address must have, at start and at completion
    // (see `vExpectedOwner`). At start, another owner or no owner fails with
    // `EMAIL_NOT_FOUND`. At completion, it fails with `INVALID_CHALLENGE`.
    expectedOwner: vExpectedOwner,
    subject: v.string(),
    intro: v.string(),
    ttlMs: v.optional(v.number()),
  },
  returns: startCustomResult,
  handler: async (ctx, args): Promise<StartCustomResult> => {
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
    const preconditions = await customStartPreconditions(ctx, args, "consume");
    if (!preconditions.success) {
      return preconditions;
    }
    const created = await createChallengeAndSendEmail(ctx, {
      email: preconditions.email,
      purpose: {
        kind: "custom",
        purpose: args.purpose,
        expectedOwner: args.expectedOwner,
      },
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
    email: v.string(),
    // The user that `email` is a verified address of when `complete` runs,
    // or `null` when it is no user's verified address. It is never `null`
    // for the `expectedOwner` kinds `user` and `anyUser`. For `user`, it is
    // that user.
    emailOwnerId: v.union(v.string(), v.null()),
  }),
  v.object({
    success: v.literal(false),
    userError: v.union(completeChallengeUserError, wrongUserUserError),
  }),
);
type CompleteResult = Infer<typeof completeResult>;

/** The claim arguments of `peek` and `complete`. */
const vCompleteArgs = {
  ...vClaimArgs,
  purpose: vPurposeName,
  currentUserId: v.union(v.string(), v.null()),
};

/** The purpose that `peek` and `complete` expect. */
function expectedPurpose(args: ObjectType<typeof vCompleteArgs>) {
  return {
    kind: "custom" as const,
    userId: args.currentUserId ?? undefined,
    purpose: args.purpose,
  };
}

/** The result of `peek` and `complete` for a claimable challenge. */
async function claimableResult(
  ctx: QueryCtx,
  row: ChallengeOfKind<"custom">,
): Promise<CompleteResult> {
  const emailOwnerId = await emailOwnerIdOf(ctx, row.email);
  const { expectedOwner } = row.purpose;
  if (!ownerMatches(expectedOwner, emailOwnerId)) {
    console.warn(
      `Rejected the email challenge ${row._id} for the purpose "custom": ` +
        `the owner of the address does not satisfy the expected owner ` +
        `"${expectedOwner.kind}" now.`,
    );
    return { success: false, userError: { error: "INVALID_CHALLENGE" } };
  }
  return { success: true, email: row.email, emailOwnerId };
}

/**
 * Report what `complete` would return for this link, without claiming it. A
 * landing page calls it to tell the user that a link is dead before it asks
 * for input. It is a query, thus a subscribed page learns that the link was
 * claimed elsewhere, or that the cleanup loop erased it after it expired.
 * It takes the same arguments as `complete`.
 *
 * A `peek` that passes does not guarantee that a later `complete` passes:
 * the link can expire or be claimed between the two calls.
 */
export const peek = query({
  args: vCompleteArgs,
  returns: completeResult,
  handler: async (ctx, args): Promise<CompleteResult> => {
    const claim = await findClaimableChallenge(ctx, {
      emailCode: args.emailCode,
      browserSecret: args.browserSecret,
      purpose: expectedPurpose(args),
    });
    if (!claim.success) {
      return claim.failure;
    }
    return await claimableResult(ctx, claim.row);
  },
});

/**
 * Complete a `custom` challenge. The `purpose` must be the one given at
 * start.
 *
 * `currentUserId` is the user that is signed in now, or `null` when no user
 * is. When `start` got an `expectedOwner` of the kind `user`,
 * `currentUserId` must be this user. Another value fails with `WRONG_USER`
 * and keeps the challenge, thus this user can still complete it. For the
 * other kinds, any value is accepted. It is required, thus a caller cannot
 * skip the check by accident.
 *
 * When the owner of the address does not satisfy the `expectedOwner` now,
 * `complete` fails with `INVALID_CHALLENGE`: after the start, the address
 * moved to another user or was removed. The claim still deletes the row,
 * thus the link does not work again.
 */
export const complete = mutation({
  args: vCompleteArgs,
  returns: completeResult,
  handler: async (ctx, args): Promise<CompleteResult> => {
    const claim = await claimChallenge(ctx, {
      emailCode: args.emailCode,
      browserSecret: args.browserSecret,
      purpose: expectedPurpose(args),
    });
    if (!claim.success) {
      return claim.failure;
    }
    return await claimableResult(ctx, claim.row);
  },
});
