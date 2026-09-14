// The background loop that erases expired challenges. Nothing else deletes
// a challenge that nobody completes, and a completion does not delete the
// other challenges for the same address, so the table would only grow.
//
// TODO: this file is a twin of `passkey/cleanup.ts`, with the cursor on
// `expiresAt` instead of `_creationTime`. Share the code if a third copy
// appears.

import { v } from "convex/values";
import { defineBatchWorkerValidators, ping } from "@convex-dev/batch-worker";
import { components, internal } from "./_generated/api.ts";
import { internalMutation, internalQuery } from "./_generated/server.ts";
import type { MutationCtx } from "./_generated/server.ts";

// The name of the batch worker loop that erases expired challenges. Only one
// loop is necessary, so the name is constant.
export const WORKER_NAME = "expiredChallenges";

// How many challenges one worker mutation erases. The worker runs again
// immediately while more expired rows stay, so this value only sets the
// size of each transaction. A challenge row is small, and the query only
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
    // The cursor is the `expiresAt` of the last challenge that the loop
    // erased. The rows below it are gone, thus the next scan starts at it
    // and does not read their tombstones.
    cursor: v.number(),
  });

/**
 * Find the next batch of expired challenges.
 *
 * When no challenge is expired, the loop goes idle. If unexpired challenges
 * stay, the loop also gets a timeout: it then wakes up again when the oldest
 * of them expires, even if no new challenge starts.
 */
export const getExpiredChallenges = internalQuery({
  args: vQueryArgs,
  returns: vQueryReturns,
  handler: async (ctx, args) => {
    const now = Date.now();
    // Each kind of challenge has its own TTL, and a custom challenge can set
    // its own, thus the rows are scanned in `expiresAt` order, not in
    // creation order. The lower bound skips the rows that the loop already
    // erased, and the upper bound keeps the read to the rows that this batch
    // erases.
    const expired = await ctx.db
      .query("challenges")
      .withIndex("by_expiresAt", (q) =>
        q
          // The bound is inclusive because two rows can share an expiry: the
          // row at the cursor is erased, but a twin of it can stay.
          .gte("expiresAt", args.cursor ?? 0)
          // The boundary matches the claim check: at exactly `expiresAt`, a
          // challenge is expired. A wake-up at the deadline thus finds work.
          .lte("expiresAt", now),
      )
      .take(BATCH_SIZE);
    if (expired.length > 0) {
      return {
        kind: "work" as const,
        batch: { events: expired.map((row) => ({ id: row._id })) },
        // The component commits the cursor with the batch, thus it only moves
        // if the rows are really erased.
        cursor: expired[expired.length - 1].expiresAt,
      };
    }
    // Nothing to erase now. The challenge with the smallest `expiresAt` is
    // the first one that expires, thus the loop wakes up again at its
    // deadline even if no new challenge starts. No row below the cursor
    // stays, thus the same lower bound applies here.
    const oldest = await ctx.db
      .query("challenges")
      .withIndex("by_expiresAt", (q) => q.gte("expiresAt", args.cursor ?? 0))
      .first();
    if (oldest === null) {
      return { kind: "idle" as const };
    }
    return {
      kind: "idle" as const,
      timeoutMs: Math.max(0, oldest.expiresAt - now),
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
  args: vMutationArgs,
  returns: vMutationReturns,
  handler: async (ctx, { events }) => {
    for (const { id } of events) {
      if ((await ctx.db.get("challenges", id)) !== null) {
        await ctx.db.delete("challenges", id);
      }
    }
    return null;
  },
});
