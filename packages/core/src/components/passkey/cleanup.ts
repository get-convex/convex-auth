import { v } from "convex/values";
import { defineBatchWorkerValidators, ping } from "@convex-dev/batch-worker";
import { components, internal } from "./_generated/api.ts";
import { internalMutation, internalQuery } from "./_generated/server.ts";
import type { MutationCtx } from "./_generated/server.ts";
import { CHALLENGE_TTL_MS } from "./validation.ts";
import { deleteDeadChallenge } from "./helpers.ts";

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

const vEvents = v.array(v.object({ id: v.id("challenges") }));

const { vQueryArgs, vQueryReturns, vMutationArgs, vMutationReturns } =
  defineBatchWorkerValidators({
    batch: { events: vEvents },
    // The cursor is the `_creationTime` of the last challenge that the loop
    // erased. The rows below it are gone, thus the next scan starts above it
    // and does not read their tombstones.
    cursor: v.number(),
  });

/**
 * Find the next batch of expired challenges.
 *
 * When no challenge is expired, the loop goes idle. If unexpired challenges
 * stay, the loop also gets a timeout: it then wakes up again when the oldest
 * of them expires, even if no new ceremony starts.
 */
export const getExpiredChallenges = internalQuery({
  args: vQueryArgs,
  returns: vQueryReturns,
  handler: async (ctx, args) => {
    const now = Date.now();
    // A challenge expires at a fixed age, thus the creation-time index sorts
    // the rows by their expiry too. The lower bound skips the rows that the
    // loop already erased, and the upper bound keeps the read to the rows
    // that this batch erases.
    const expired = await ctx.db
      .query("challenges")
      .withIndex("by_creation_time", (q) =>
        q
          // The bound is inclusive because two rows can share a creation
          // time: the row at the cursor is erased, but a twin of it can stay.
          .gte("_creationTime", args.cursor ?? 0)
          // The boundary matches `isChallengeExpired`: at exactly the TTL, a
          // challenge is expired. A wake-up at the deadline thus finds work.
          .lte("_creationTime", now - CHALLENGE_TTL_MS),
      )
      .take(BATCH_SIZE);
    if (expired.length > 0) {
      return {
        kind: "work" as const,
        batch: { events: expired.map((row) => ({ id: row._id })) },
        // The component commits the cursor with the batch, thus it only moves
        // if the rows are really erased.
        cursor: expired[expired.length - 1]._creationTime,
      };
    }
    // Nothing to erase now. The oldest remaining challenge is the first one
    // that expires, thus the loop wakes up again at its deadline even if no
    // new ceremony starts. No row below the cursor stays, thus the same lower
    // bound applies here.
    const oldest = await ctx.db
      .query("challenges")
      .withIndex("by_creation_time", (q) =>
        q.gte("_creationTime", args.cursor ?? 0),
      )
      .first();
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
 * Erase one batch of expired challenges, together with their unlinked handles.
 *
 * The worker owns the cleanup of the rows that it processes. The query runs on
 * the snapshot of this transaction, and each delete takes a read dependency on
 * its row, thus every row of the batch still exists here.
 */
export const deleteExpiredChallenges = internalMutation({
  args: vMutationArgs,
  returns: vMutationReturns,
  handler: async (ctx, { events }) => {
    for (const { id } of events) {
      const challenge = await ctx.db.get("challenges", id);
      if (challenge !== null) {
        await deleteDeadChallenge(ctx, challenge);
      }
    }
    return null;
  },
});
