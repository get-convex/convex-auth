import { GenericId, Infer, v } from "convex/values";
import { ActionCtx, MutationCtx } from "../types.js";
import { LOG_LEVELS, TOKEN_SUB_CLAIM_DIVIDER, logWithLevel } from "../utils.js";

export const createPasskeyChallengeArgs = v.object({
  challenge: v.string(),
  // "registration" or "authentication". Named `challengeType` to avoid
  // colliding with the `auth:store` discriminator field `type`.
  challengeType: v.string(),
  provider: v.string(),
  expirationTime: v.number(),
});

// How many expired challenges to reap per options request. Keeps the cleanup
// bounded (and cheap) while ensuring the table stays small under steady churn.
const EXPIRED_CHALLENGE_CLEANUP_BATCH = 50;

export async function createPasskeyChallengeImpl(
  ctx: MutationCtx,
  args: Infer<typeof createPasskeyChallengeArgs>,
): Promise<void> {
  logWithLevel(LOG_LEVELS.DEBUG, "createPasskeyChallengeImpl", {
    challengeType: args.challengeType,
    provider: args.provider,
  });
  // Challenges are only deleted when consumed, so abandoned ceremonies (the
  // user dismisses the prompt, or an unauthenticated client spams options)
  // would otherwise accumulate forever on this public path. Opportunistically
  // reap a bounded batch of expired rows before inserting the new one.
  const now = Date.now();
  const expired = await ctx.db
    .query("authPasskeyChallenges")
    .withIndex("expirationTime", (q) => q.lt("expirationTime", now))
    .take(EXPIRED_CHALLENGE_CLEANUP_BATCH);
  for (const row of expired) {
    await ctx.db.delete(row._id);
  }
  // Capture the currently signed-in user (if any) so a registration can be
  // linked to them rather than creating a new user. Read here, in the
  // mutation, where `ctx.auth` is reliably available.
  let userId: GenericId<"users"> | undefined;
  if (args.challengeType === "registration") {
    const identity = await ctx.auth.getUserIdentity();
    if (identity !== null) {
      userId = identity.subject.split(
        TOKEN_SUB_CLAIM_DIVIDER,
      )[0] as GenericId<"users">;
    }
  }
  await ctx.db.insert("authPasskeyChallenges", {
    challenge: args.challenge,
    challengeType: args.challengeType,
    provider: args.provider,
    userId,
    expirationTime: args.expirationTime,
  });
}

export const callCreatePasskeyChallenge = async (
  ctx: ActionCtx,
  args: Infer<typeof createPasskeyChallengeArgs>,
): Promise<void> => {
  return ctx.runMutation("auth:store" as any, {
    args: { type: "createPasskeyChallenge", ...args },
  });
};

export const consumePasskeyChallengeArgs = v.object({
  challenge: v.string(),
  challengeType: v.string(),
  provider: v.string(),
});

type ConsumeResult = {
  userId?: GenericId<"users">;
} | null;

export async function consumePasskeyChallengeImpl(
  ctx: MutationCtx,
  args: Infer<typeof consumePasskeyChallengeArgs>,
): Promise<ConsumeResult> {
  const existing = await ctx.db
    .query("authPasskeyChallenges")
    .withIndex("challenge", (q) => q.eq("challenge", args.challenge))
    .unique();
  if (
    existing === null ||
    existing.challengeType !== args.challengeType ||
    existing.provider !== args.provider
  ) {
    return null;
  }
  // Always delete: challenges are single-use, even if expired.
  await ctx.db.delete(existing._id);
  if (existing.expirationTime < Date.now()) {
    return null;
  }
  return { userId: existing.userId };
}

export const callConsumePasskeyChallenge = async (
  ctx: ActionCtx,
  args: Infer<typeof consumePasskeyChallengeArgs>,
): Promise<ConsumeResult> => {
  return ctx.runMutation("auth:store" as any, {
    args: { type: "consumePasskeyChallenge", ...args },
  });
};
