import { v } from "convex/values";
import { ping, vBatchQueryArgs, vBatchResult } from "@convex-dev/batch-worker";
import { components, internal } from "./_generated/api";
import { internalMutation, internalQuery } from "./_generated/server";
import type { MutationCtx } from "./_generated/server";
import { CHALLENGE_TTL_MS } from "./validation";

// The name of the batch worker loop that erases expired challenges. Only one
// loop is necessary, so the name is constant.
export const WORKER_NAME = "expiredChallenges";

// How many challenges one worker mutation erases. The worker runs again
// immediately while more expired rows stay, so this value only sets the
// size of each transaction. A challenge row is tiny, and the query only
// reads rows that are expired, thus a large batch stays cheap.
const BATCH_SIZE = 1024;

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
    // A challenge expires at a fixed age, thus the creation-time index sorts
    // the rows by their expiry too. The bound keeps the read to the rows that
    // the batch erases.
    const expired = await ctx.db
      .query("challenges")
      .withIndex("by_creation_time", (q) =>
        // The boundary matches `isChallengeExpired`: at exactly the TTL, a
        // challenge is expired. A wake-up at the deadline thus finds work.
        q.lte("_creationTime", now - CHALLENGE_TTL_MS),
      )
      .take(BATCH_SIZE);
    if (expired.length > 0) {
      return {
        kind: "work" as const,
        batch: { ids: expired.map((row) => row._id) },
      };
    }
    // Nothing to erase now. The oldest remaining challenge is the first one
    // that expires, thus the loop wakes up again at its deadline even if no
    // new ceremony starts.
    const oldest = await ctx.db.query("challenges").order("asc").first();
    if (oldest === null) {
      return { kind: "idle" as const };
    }
    return {
      kind: "idle" as const,
      timeoutMs: Math.max(0, oldest._creationTime + CHALLENGE_TTL_MS - now),
    };
  },
});

/**
 * Erase one batch of expired challenges.
 *
 * The worker owns the cleanup of the rows that it processes. The query runs on
 * the snapshot of this transaction, and each delete takes a read dependency on
 * its row, thus every row of the batch still exists here.
 */
export const deleteExpiredChallenges = internalMutation({
  args: { ids: v.array(v.id("challenges")) },
  returns: v.null(),
  handler: async (ctx, { ids }) => {
    for (const id of ids) {
      await ctx.db.delete("challenges", id);
    }
    return null;
  },
});
