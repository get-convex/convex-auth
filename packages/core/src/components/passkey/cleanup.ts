import { v } from "convex/values";
import { ping, vBatchQueryArgs, vBatchResult } from "@convex-dev/batch-worker";
import { components, internal } from "./_generated/api";
import { internalMutation, internalQuery } from "./_generated/server";
import type { MutationCtx } from "./_generated/server";
import { CHALLENGE_TTL_MS } from "./validation";
import { isChallengeExpired } from "./helpers";

// The name of the batch worker loop that erases expired challenges. Only one
// loop is necessary, so the name is constant.
export const WORKER_NAME = "expiredChallenges";

// How many challenges one worker mutation erases. The worker runs again
// immediately while more expired rows stay, so this value only sets the
// size of each transaction.
const BATCH_SIZE = 64;

/**
 * Make sure that the background cleanup loop runs.
 *
 * Call this function after you write a challenge. The call is cheap: it does
 * nothing while the loop already runs. The loop stops when no expired
 * challenge stays.
 */
export async function scheduleChallengeCleanup(ctx: MutationCtx) {
  await ping(ctx, components.batchWorker, {
    name: WORKER_NAME,
    workQuery: internal.cleanup.getExpiredChallenges,
    workerMutation: internal.cleanup.deleteExpiredChallenges,
  });
}

/**
 * Find the next batch of expired challenges.
 *
 * When no challenge is expired, the loop goes idle. If unexpired challenges
 * stay, the loop also gets a timeout: it then wakes up again when the oldest
 * of them expires, even if no new ceremony starts.
 */
export const getExpiredChallenges = internalQuery({
  args: vBatchQueryArgs,
  returns: vBatchResult(v.object({ ids: v.array(v.id("challenges")) })),
  handler: async (ctx) => {
    const now = Date.now();
    // One indexed read answers both questions: which rows are expired, and
    // when the oldest row expires. The index sorts by `createdAt`, so the
    // batch holds the oldest rows.
    const oldestRows = await ctx.db
      .query("challenges")
      .withIndex("by_createdAt")
      .take(BATCH_SIZE);
    const expired = oldestRows.filter((row) => isChallengeExpired(row, now));
    if (expired.length > 0) {
      return {
        kind: "work" as const,
        batch: { ids: expired.map((row) => row._id) },
      };
    }
    // Nothing to erase now. The oldest remaining challenge is the first one
    // that expires.
    const oldest = oldestRows[0];
    if (oldest === undefined) {
      return { kind: "idle" as const };
    }
    return {
      kind: "idle" as const,
      timeoutMs: Math.max(0, oldest.createdAt + CHALLENGE_TTL_MS - now),
    };
  },
});

/**
 * Erase one batch of expired challenges.
 *
 * The worker owns the cleanup of the rows that it processes. A challenge can
 * also be consumed between the query and this mutation, thus the rows that no
 * longer exist are ignored.
 */
export const deleteExpiredChallenges = internalMutation({
  args: { ids: v.array(v.id("challenges")) },
  returns: v.null(),
  handler: async (ctx, { ids }) => {
    for (const id of ids) {
      if ((await ctx.db.get("challenges", id)) !== null) {
        await ctx.db.delete("challenges", id);
      }
    }
    return null;
  },
});
