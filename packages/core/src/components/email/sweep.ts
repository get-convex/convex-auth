import { v } from "convex/values";
import { defineBatchWorkerValidators, ping } from "@convex-dev/batch-worker";
import { components, internal } from "./_generated/api.ts";
import { internalMutation, internalQuery } from "./_generated/server.ts";
import type { MutationCtx } from "./_generated/server.ts";

// The sweep loop deletes the challenge rows that can no longer be used:
// - completed rows: `challenge.complete` set `completedAt`, and the proof was
//   not spent in the same mutation (recovery, re-authentication). The loop
//   deletes them right after that mutation commits, so a proof cannot be
//   spent from a later mutation;
// - expired rows: `expiresAt` is in the past.

// The name of the batch worker loop. Only one loop is necessary, so the name
// is constant.
export const WORKER_NAME = "challengeSweep";

// How many rows one worker mutation deletes. The worker runs again
// immediately while more rows stay, so this value only sets the size of each
// transaction.
const BATCH_SIZE = 1024;

// How long the loop waits after a ping before its first batch, so that a
// burst of completions is deleted in one transaction instead of one
// transaction each. TODO: review this value.
const DEBOUNCE_MS = 5_000;

// The scans start this far below the cursor. `completedAt` and `expiresAt`
// come from `Date.now()` in the mutation that wrote them, and a mutation that
// commits after the query ran can carry a slightly older clock than the
// cursor. Rows in this window are re-read; those already deleted are cheap
// tombstones.
const CURSOR_GRACE_MS = 60_000;

/**
 * Make sure that the sweep loop runs.
 *
 * `challenge.start` and `challenge.complete` call this function. The call is
 * cheap: it does nothing while the loop already runs. The loop goes idle when
 * no row is due, and wakes up again when the next row expires.
 */
export async function scheduleChallengeSweep(ctx: MutationCtx) {
  await ping(ctx, components.batchWorker, {
    name: WORKER_NAME,
    workQuery: internal.sweep.getDueChallenges,
    workerMutation: internal.sweep.deleteChallenges,
    config: { debounceMs: DEBOUNCE_MS },
  });
}

const { vQueryArgs, vQueryReturns, vMutationArgs, vMutationReturns } =
  defineBatchWorkerValidators({
    batch: { ids: v.array(v.id("challenges")) },
    // How far each scan got: the largest `completedAt` and `expiresAt` that
    // the loop deleted. The next scan starts just below them, so it does not
    // read the tombstones of the rows it already deleted.
    cursor: v.object({ completedAt: v.number(), expiresAt: v.number() }),
  });

/**
 * Find the next batch of rows to delete: completed rows first, then expired
 * rows.
 *
 * When no row is due, the loop goes idle. If unexpired rows stay, the loop
 * gets a timeout, so that it wakes up when the oldest of them expires even if
 * no new challenge starts or completes.
 */
export const getDueChallenges = internalQuery({
  args: vQueryArgs,
  returns: vQueryReturns,
  handler: async (ctx, args) => {
    const now = Date.now();
    const cursor = args.cursor ?? { completedAt: 0, expiresAt: 0 };

    const completed = await ctx.db
      .query("challenges")
      .withIndex("by_completedAt", (q) =>
        q
          .gte("completedAt", cursor.completedAt - CURSOR_GRACE_MS)
          .lte("completedAt", now),
      )
      .take(BATCH_SIZE);
    if (completed.length > 0) {
      return {
        kind: "work" as const,
        batch: { ids: completed.map((row) => row._id) },
        cursor: {
          ...cursor,
          completedAt: completed[completed.length - 1].completedAt ?? now,
        },
      };
    }

    const expired = await ctx.db
      .query("challenges")
      .withIndex("by_expiresAt", (q) =>
        q
          .gte("expiresAt", cursor.expiresAt - CURSOR_GRACE_MS)
          .lt("expiresAt", now),
      )
      .take(BATCH_SIZE);
    if (expired.length > 0) {
      return {
        kind: "work" as const,
        batch: { ids: expired.map((row) => row._id) },
        cursor: { ...cursor, expiresAt: expired[expired.length - 1].expiresAt },
      };
    }

    // Nothing is due. The row with the smallest `expiresAt` is the next one
    // that becomes due.
    const next = await ctx.db
      .query("challenges")
      .withIndex("by_expiresAt", (q) => q.gte("expiresAt", now))
      .first();
    if (next === null) {
      return { kind: "idle" as const };
    }
    return { kind: "idle" as const, timeoutMs: next.expiresAt - now };
  },
});

/**
 * Delete one batch of rows.
 *
 * A row can be gone already: `verifiedEmails.add` spends proofs and deletes
 * the row, and `challenge.complete` deletes rows on a failed claim. The
 * mutation ignores those.
 */
export const deleteChallenges = internalMutation({
  args: vMutationArgs,
  returns: vMutationReturns,
  handler: async (ctx, { ids }) => {
    for (const id of ids) {
      if ((await ctx.db.get("challenges", id)) !== null) {
        await ctx.db.delete("challenges", id);
      }
    }
    return null;
  },
});
