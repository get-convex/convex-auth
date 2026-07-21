/**
 * `component.group.*` — hierarchical groups (the group entity root;
 * members/invites are sub-resources under `group.member` / `group.invite`).
 *
 * `ancestors` is a kept domain read (hierarchy walk).
 *
 * @module
 */

import { paginationOptsValidator } from "convex/server";
import { ConvexError, v } from "convex/values";
import { stream } from "convex-helpers/server/stream";
import { ErrorCode } from "../shared/codes";

import { internal } from "./_generated/api";
import type { Doc, Id } from "./_generated/dataModel";
import type { MutationCtx } from "./_generated/server";
import { internalMutation, mutation, query } from "./functions";
import schema from "./schema";
import { vGroupConnectionPolicy, vGroupDoc, vPaginated } from "./model";

/**
 * Read a group by `id`, or batch-read by `ids` (result aligned to input
 * order, with `null` for missing ids and duplicates preserved).
 */
export const get = query({
  args: {
    id: v.optional(v.id("Group")),
    ids: v.optional(v.array(v.id("Group"))),
  },
  returns: v.union(vGroupDoc, v.null(), v.array(v.union(vGroupDoc, v.null()))),
  handler: async (ctx, args) => {
    if (args.ids !== undefined) {
      if (args.ids.length === 0) return [];
      const unique = Array.from(new Set(args.ids));
      const docs = await Promise.all(unique.map((id) => ctx.db.get("Group", id)));
      const byId = new Map(unique.map((id, i) => [id, docs[i] ?? null]));
      return args.ids.map((id) => byId.get(id) ?? null);
    }
    if (args.id === undefined) return null;
    return await ctx.db.get("Group", args.id);
  },
});

/**
 * Walk the parent chain from a group up to the root, returning the ordered
 * ancestor docs. Flags `cycleDetected` and `maxDepthReached` so callers can
 * tell a truncated walk from a complete one; `includeSelf` prepends the
 * starting group.
 */
export const ancestors = query({
  args: {
    id: v.id("Group"),
    maxDepth: v.optional(v.number()),
    includeSelf: v.optional(v.boolean()),
  },
  returns: v.object({
    ancestors: v.array(vGroupDoc),
    cycleDetected: v.boolean(),
    maxDepthReached: v.boolean(),
  }),
  handler: async (ctx, { id: groupId, maxDepth, includeSelf }) => {
    const limit = Math.max(0, Math.floor(maxDepth ?? 32));
    const visited = new Set<string>();
    const ancestors: Array<Doc<"Group">> = [];
    let cycleDetected = false;
    let maxDepthReached = false;
    let current: Id<"Group"> | undefined = groupId;
    let depth = 0;
    let first = true;
    while (current !== undefined) {
      if (depth > limit) {
        maxDepthReached = true;
        break;
      }
      if (visited.has(current)) {
        cycleDetected = true;
        break;
      }
      visited.add(current);
      const doc = await ctx.db.get("Group", current);
      if (doc === null) break;
      if (first) {
        first = false;
        if (includeSelf === true) ancestors.push(doc);
      } else {
        ancestors.push(doc);
      }
      current = doc.parentGroupId as Id<"Group"> | undefined;
      depth += 1;
    }
    return { ancestors, cycleDetected, maxDepthReached };
  },
});

/** List groups, paginated, optionally filtered by `where` and sorted via `orderBy`/`order`. */
export const list = query({
  args: {
    where: v.optional(
      v.object({
        slug: v.optional(v.string()),
        type: v.optional(v.string()),
        parentGroupId: v.optional(v.id("Group")),
        name: v.optional(v.string()),
        isRoot: v.optional(v.boolean()),
      }),
    ),
    paginationOpts: paginationOptsValidator,
    orderBy: v.optional(
      v.union(v.literal("_creationTime"), v.literal("name"), v.literal("slug"), v.literal("type")),
    ),
    order: v.optional(v.union(v.literal("asc"), v.literal("desc"))),
  },
  returns: vPaginated(vGroupDoc),
  handler: async (ctx, args) => {
    const where = args.where ?? {};
    const order = args.order ?? "desc";
    const orderBy = args.orderBy ?? "_creationTime";

    const base = stream(ctx.db, schema).query("Group");
    let q;
    if (orderBy === "name") {
      q =
        where.parentGroupId !== undefined
          ? where.name !== undefined
            ? base.withIndex("parent_group_id_name", (idx) =>
                idx.eq("parentGroupId", where.parentGroupId!).eq("name", where.name!),
              )
            : base.withIndex("parent_group_id_name", (idx) =>
                idx.eq("parentGroupId", where.parentGroupId!),
              )
          : base.withIndex("name");
    } else if (orderBy === "slug") {
      q =
        where.parentGroupId !== undefined
          ? where.slug !== undefined
            ? base.withIndex("parent_group_id_slug", (idx) =>
                idx.eq("parentGroupId", where.parentGroupId!).eq("slug", where.slug!),
              )
            : base.withIndex("parent_group_id_slug", (idx) =>
                idx.eq("parentGroupId", where.parentGroupId!),
              )
          : where.slug !== undefined
            ? base.withIndex("slug", (idx) => idx.eq("slug", where.slug!))
            : base.withIndex("slug");
    } else if (orderBy === "type") {
      q =
        where.parentGroupId !== undefined
          ? where.type !== undefined
            ? base.withIndex("parent_group_id_type", (idx) =>
                idx.eq("parentGroupId", where.parentGroupId!).eq("type", where.type!),
              )
            : base.withIndex("parent_group_id_type", (idx) =>
                idx.eq("parentGroupId", where.parentGroupId!),
              )
          : where.type !== undefined
            ? base.withIndex("type", (idx) => idx.eq("type", where.type!))
            : base.withIndex("type");
    } else if (where.type !== undefined && where.parentGroupId !== undefined) {
      q = base.withIndex("type_parent_group_id", (idx) =>
        idx.eq("type", where.type!).eq("parentGroupId", where.parentGroupId!),
      );
    } else if (where.slug !== undefined) {
      q = base.withIndex("slug", (idx) => idx.eq("slug", where.slug!));
    } else if (where.type !== undefined) {
      q = base.withIndex("type", (idx) => idx.eq("type", where.type!));
    } else if (where.parentGroupId !== undefined) {
      q = base.withIndex("parent_group_id", (idx) => idx.eq("parentGroupId", where.parentGroupId!));
    } else if (where.isRoot !== undefined) {
      q = base.withIndex("is_root", (idx) => idx.eq("isRoot", where.isRoot!));
    } else {
      q = base;
    }

    return await q
      .order(order)
      .filterWith(
        async (d) =>
          (where.slug === undefined || d.slug === where.slug) &&
          (where.type === undefined || d.type === where.type) &&
          (where.parentGroupId === undefined || d.parentGroupId === where.parentGroupId) &&
          (where.name === undefined || d.name === where.name) &&
          (where.isRoot === undefined || d.isRoot === where.isRoot),
      )
      .paginate(args.paginationOpts);
  },
});

/**
 * Insert a new group. A group with no `parentGroupId` is a root and is
 * back-patched to point `rootGroupId` at itself; otherwise it inherits the
 * parent's `rootGroupId`.
 */
export const create = mutation({
  args: {
    name: v.string(),
    slug: v.optional(v.string()),
    type: v.optional(v.string()),
    parentGroupId: v.optional(v.id("Group")),
    extend: v.optional(v.any()),
  },
  returns: v.id("Group"),
  handler: async (ctx, args) => {
    const isRoot = !args.parentGroupId;
    let rootGroupId: Id<"Group"> | undefined;
    if (!isRoot && args.parentGroupId) {
      const parent = await ctx.db.get("Group", args.parentGroupId);
      rootGroupId = parent?.rootGroupId ?? args.parentGroupId;
    }
    const groupId = await ctx.db.insert("Group", {
      ...args,
      isRoot,
      rootGroupId: isRoot ? undefined : rootGroupId,
    });
    if (isRoot) {
      await ctx.db.patch("Group", groupId, { rootGroupId: groupId });
    }
    return groupId;
  },
});

// ---------------------------------------------------------------------------
// Subtree cascade (delete + re-parent re-stamp)
//
// A group's subtree can be arbitrarily wide and deep, so a single mutation
// cannot be trusted to visit the whole thing: `CASCADE_MAX` only bounds
// per-node *width*, not the total subtree, and a large tree blows the
// per-transaction read/write budget — the mutation rolls back and the group
// becomes undeletable / un-re-parentable. Following the `connection.remove`
// pattern, each transaction processes a budgeted batch of nodes and reschedules
// a continuation (`internal.group.purgeGroupData` / `internal.group.restampGroupData`)
// while work remains. The per-node `CASCADE_TOO_LARGE` guard is preserved for
// pathological single-node fan-out; the migrations component remains the escape
// hatch for genuinely huge trees.
// ---------------------------------------------------------------------------

/** Max rows in one child/member/invite table for a single group node before we
 *  refuse (per-node width guard, preserved from the original cascade). */
const CASCADE_MAX = 1000;
/** Max group nodes fully processed in a single cascade transaction (keeps the
 *  per-tx index-range count well under budget: <= ~4 reads/node). */
const CASCADE_NODES_PER_RUN = 256;
/** Soft cap on rows scanned/written accumulated per cascade transaction, so one
 *  run stays well under the per-tx read/write limits even with wide nodes. */
const CASCADE_ROWS_PER_RUN = 8192;
/** Safety valve on the carried continuation frontier: beyond this the pending
 *  subtree is too wide to drain safely via scheduled continuations, so we refuse
 *  and point at the migrations component (bounds the continuation's arg size — an
 *  Id is ~36 bytes, so 16384 is well under Convex's argument-size limit). Only a
 *  genuinely enormous subgroup wavefront reaches this. */
const CASCADE_FRONTIER_MAX = 16_384;

function refuseCascadeOverflow(id: Id<"Group">, table: string, count: number) {
  if (count > CASCADE_MAX) {
    throw new ConvexError({
      code: ErrorCode.CASCADE_TOO_LARGE,
      message: `Group ${id} has more than ${CASCADE_MAX} rows in ${table}; cascade is not safe in a single mutation. Drain via the migrations component first, then retry.`,
    });
  }
}

function refuseFrontierOverflow(remaining: number) {
  if (remaining > CASCADE_FRONTIER_MAX) {
    throw new ConvexError({
      code: ErrorCode.CASCADE_TOO_LARGE,
      message: `Group subtree pending frontier exceeds ${CASCADE_FRONTIER_MAX} nodes; cascade is not safe to continue in scheduled mutations. Drain via the migrations component first, then retry.`,
    });
  }
}

/**
 * Delete a budgeted slice of the group subtree seeded by `frontier`, draining as
 * far as the per-transaction budget allows within this one transaction. Newly
 * discovered child groups are appended to the same work queue and processed in
 * the same run until either the node or row budget is hit, so a normal (small)
 * subtree is fully deleted inline with no continuation. For each processed node
 * it deletes that node's memberships and invites, deletes the node itself, and
 * enqueues its child groups (captured before the node is deleted, so top-down
 * deletion never orphans a descendant). Returns the still-unprocessed queue tail
 * (unvisited seeds + discovered children); the caller reschedules a continuation
 * while it is non-empty.
 *
 * Cross-transaction cycle/duplicate safety: a node already deleted by an earlier
 * run is skipped (its `db.get` is `null`), so a `parentGroupId` cycle terminates.
 */
async function purgeGroupSubtree(
  ctx: MutationCtx,
  frontier: Array<Id<"Group">>,
): Promise<Array<Id<"Group">>> {
  const queue: Array<Id<"Group">> = [...frontier];
  let head = 0;
  let processed = 0;
  let rows = 0;
  while (head < queue.length && processed < CASCADE_NODES_PER_RUN && rows < CASCADE_ROWS_PER_RUN) {
    const id = queue[head];
    head += 1;
    processed += 1;
    const node = await ctx.db.get("Group", id);
    if (node === null) continue;

    const children = await ctx.db
      .query("Group")
      .withIndex("parent_group_id", (q) => q.eq("parentGroupId", id))
      .take(CASCADE_MAX + 1);
    refuseCascadeOverflow(id, "Group(children)", children.length);
    for (const child of children) queue.push(child._id);
    rows += children.length;

    const members = await ctx.db
      .query("GroupMember")
      .withIndex("group_id", (q) => q.eq("groupId", id))
      .take(CASCADE_MAX + 1);
    refuseCascadeOverflow(id, "GroupMember", members.length);
    for (const member of members) await ctx.db.delete("GroupMember", member._id);
    rows += members.length;

    const invites = await ctx.db
      .query("GroupInvite")
      .withIndex("group_id", (q) => q.eq("groupId", id))
      .take(CASCADE_MAX + 1);
    refuseCascadeOverflow(id, "GroupInvite", invites.length);
    for (const invite of invites) await ctx.db.delete("GroupInvite", invite._id);
    rows += invites.length;

    await ctx.db.delete("Group", id);
    rows += 1;
  }
  const remaining = queue.slice(head);
  refuseFrontierOverflow(remaining.length);
  return remaining;
}

/**
 * Re-stamp `rootGroupId = newRootGroupId` across the subtree seeded by
 * `frontier`, draining as far as the per-transaction budget allows in this one
 * transaction (discovered children are appended to the same work queue), so a
 * normal subtree converges inline. A child that already carries `newRootGroupId`
 * is skipped (idempotent + cycle-safe), so the walk terminates. Returns the
 * still-unprocessed queue tail for the caller to reschedule.
 */
async function restampGroupSubtree(
  ctx: MutationCtx,
  frontier: Array<Id<"Group">>,
  newRootGroupId: Id<"Group">,
): Promise<Array<Id<"Group">>> {
  const queue: Array<Id<"Group">> = [...frontier];
  let head = 0;
  let processed = 0;
  let rows = 0;
  while (head < queue.length && processed < CASCADE_NODES_PER_RUN && rows < CASCADE_ROWS_PER_RUN) {
    const parentId = queue[head];
    head += 1;
    processed += 1;
    const children = await ctx.db
      .query("Group")
      .withIndex("parent_group_id", (q) => q.eq("parentGroupId", parentId))
      .take(CASCADE_MAX + 1);
    refuseCascadeOverflow(parentId, "Group(children)", children.length);
    rows += children.length;
    for (const child of children) {
      if (child.rootGroupId === newRootGroupId) continue;
      await ctx.db.patch("Group", child._id, { rootGroupId: newRootGroupId });
      queue.push(child._id);
      rows += 1;
    }
  }
  const remaining = queue.slice(head);
  refuseFrontierOverflow(remaining.length);
  return remaining;
}

/**
 * Continuation for {@link remove}: drains the remaining delete frontier a
 * budgeted batch at a time, rescheduling itself until the subtree is gone.
 */
export const purgeGroupData = internalMutation({
  args: { frontier: v.array(v.id("Group")) },
  returns: v.null(),
  handler: async (ctx, { frontier }) => {
    const remaining = await purgeGroupSubtree(ctx, frontier);
    if (remaining.length > 0) {
      await ctx.scheduler.runAfter(0, internal.group.purgeGroupData, { frontier: remaining });
    }
    return null;
  },
});

/**
 * Continuation for {@link update}'s re-parent re-stamp: drains the remaining
 * frontier a budgeted batch at a time, rescheduling until every descendant
 * carries the new `rootGroupId`.
 */
export const restampGroupData = internalMutation({
  args: { frontier: v.array(v.id("Group")), newRootGroupId: v.id("Group") },
  returns: v.null(),
  handler: async (ctx, { frontier, newRootGroupId }) => {
    const remaining = await restampGroupSubtree(ctx, frontier, newRootGroupId);
    if (remaining.length > 0) {
      await ctx.scheduler.runAfter(0, internal.group.restampGroupData, {
        frontier: remaining,
        newRootGroupId,
      });
    }
    return null;
  },
});

/**
 * Patch fields on a group. Re-parenting (a `patch.parentGroupId`) recomputes
 * `isRoot`/`rootGroupId` and cascades the new `rootGroupId` to every
 * descendant in the moved subtree. The re-stamp is paginated across scheduled
 * continuations, so a large subtree no longer overflows a single mutation
 * (see the subtree-cascade note above); descendants converge on the new
 * `rootGroupId` asynchronously.
 */
export const update = mutation({
  args: {
    id: v.id("Group"),
    patch: v.object({
      name: v.optional(v.string()),
      slug: v.optional(v.string()),
      type: v.optional(v.string()),
      parentGroupId: v.optional(v.id("Group")),
      rootGroupId: v.optional(v.id("Group")),
      isRoot: v.optional(v.boolean()),
      policy: v.optional(vGroupConnectionPolicy),
      extend: v.optional(v.any()),
    }),
  },
  returns: v.null(),
  handler: async (ctx, { id: groupId, patch }) => {
    if (patch.parentGroupId !== undefined) {
      const oldGroup = await ctx.db.get("Group", groupId);
      const oldRootGroupId = oldGroup?.rootGroupId;
      const newParentGroupId = patch.parentGroupId as Id<"Group"> | undefined;
      const newIsRoot = !newParentGroupId;
      let newRootGroupId: Id<"Group">;
      if (newIsRoot) {
        newRootGroupId = groupId;
      } else {
        const parent = await ctx.db.get("Group", newParentGroupId!);
        newRootGroupId = parent?.rootGroupId ?? newParentGroupId!;
      }
      patch.isRoot = newIsRoot;
      patch.rootGroupId = newRootGroupId;
      if (oldRootGroupId && oldRootGroupId !== newRootGroupId) {
        const remaining = await restampGroupSubtree(ctx, [groupId], newRootGroupId);
        if (remaining.length > 0) {
          await ctx.scheduler.runAfter(0, internal.group.restampGroupData, {
            frontier: remaining,
            newRootGroupId,
          });
        }
      }
    }
    await ctx.db.patch("Group", groupId, patch);
    return null;
  },
});

/**
 * Delete a group and cascade-delete its descendant groups, memberships, and
 * invites. The subtree is drained a budgeted batch at a time, rescheduling a
 * `purgeGroupData` continuation while nodes remain (see the subtree-cascade note
 * above), so a large tree no longer overflows a single mutation and is left
 * undeletable. The per-node `CASCADE_TOO_LARGE` guard is preserved for
 * pathological single-node fan-out.
 */
const remove = mutation({
  args: { id: v.id("Group") },
  returns: v.null(),
  handler: async (ctx, { id: groupId }) => {
    const remaining = await purgeGroupSubtree(ctx, [groupId]);
    if (remaining.length > 0) {
      await ctx.scheduler.runAfter(0, internal.group.purgeGroupData, { frontier: remaining });
    }
    return null;
  },
});

export { remove };
