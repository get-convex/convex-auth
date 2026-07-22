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
import { paginator } from "convex-helpers/server/pagination";
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
      await assertGroupCanAcceptChild(ctx, args.parentGroupId);
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
// Durable subtree operations (delete + re-parent re-stamp)
// ---------------------------------------------------------------------------

/** Small subtrees keep the original synchronous, all-or-nothing behavior. */
const INLINE_GROUP_LIMIT = 48;
const INLINE_RELATION_LIMIT = 384;
/** Durable jobs deliberately use small pages to leave transaction headroom. */
const PLAN_ITEMS_PER_RUN = 4;
const CHILDREN_PER_PAGE = 32;
const APPLY_ITEMS_PER_RUN = 16;
const RELATIONS_PER_RUN = 64;
const CLEANUP_ITEMS_PER_RUN = 128;

type InlineSubtree = {
  groups: Array<Doc<"Group">>;
  members: Array<Doc<"GroupMember">>;
  invites: Array<Doc<"GroupInvite">>;
};

/**
 * Collect a subtree only while it is known to fit comfortably in one
 * transaction. Returning `null` is not an error: it selects the durable path,
 * and no hierarchy row has been changed yet.
 */
async function collectInlineSubtree(
  ctx: MutationCtx,
  groupId: Id<"Group">,
  includeRelations: boolean,
): Promise<InlineSubtree | null> {
  const queue = [groupId];
  const seen = new Set<string>();
  const groups: Array<Doc<"Group">> = [];
  const members: Array<Doc<"GroupMember">> = [];
  const invites: Array<Doc<"GroupInvite">> = [];

  for (let head = 0; head < queue.length; head += 1) {
    const id = queue[head];
    if (seen.has(id)) continue;
    seen.add(id);
    if (seen.size > INLINE_GROUP_LIMIT) return null;

    const group = await ctx.db.get("Group", id);
    if (group === null) continue;
    groups.push(group);

    const children = await ctx.db
      .query("Group")
      .withIndex("parent_group_id", (q) => q.eq("parentGroupId", id))
      .take(INLINE_GROUP_LIMIT + 1);
    if (children.length > INLINE_GROUP_LIMIT) return null;
    queue.push(...children.map((child) => child._id));
    if (queue.length > INLINE_GROUP_LIMIT * 2) return null;

    if (!includeRelations) continue;
    const groupMembers = await ctx.db
      .query("GroupMember")
      .withIndex("group_id", (q) => q.eq("groupId", id))
      .take(INLINE_RELATION_LIMIT + 1);
    const groupInvites = await ctx.db
      .query("GroupInvite")
      .withIndex("group_id", (q) => q.eq("groupId", id))
      .take(INLINE_RELATION_LIMIT + 1);
    members.push(...groupMembers);
    invites.push(...groupInvites);
    if (members.length + invites.length > INLINE_RELATION_LIMIT) return null;
  }
  return { groups, members, invites };
}

async function scheduleHierarchyOperation(
  ctx: MutationCtx,
  operationId: Id<"GroupHierarchyOperation">,
) {
  await ctx.scheduler.runAfter(0, internal.group.processGroupHierarchy, { operationId });
}

async function createHierarchyOperation(
  ctx: MutationCtx,
  args:
    | { groupId: Id<"Group">; kind: "remove" }
    | {
        groupId: Id<"Group">;
        kind: "restamp";
        newRootGroupId: Id<"Group">;
        expectedParentGroupId: Id<"Group">;
      },
) {
  const operationId = await ctx.db.insert("GroupHierarchyOperation", {
    ...args,
    phase: "planning",
  });
  await ctx.db.insert("GroupHierarchyWork", {
    operationId,
    kind: args.kind,
    groupId: args.groupId,
    depth: 0,
    planned: false,
    applied: false,
  });
  await scheduleHierarchyOperation(ctx, operationId);
  return operationId;
}

async function activeRemovalForGroup(ctx: MutationCtx, groupId: Id<"Group">) {
  const work = await ctx.db
    .query("GroupHierarchyWork")
    .withIndex("group_id_kind", (q) => q.eq("groupId", groupId).eq("kind", "remove"))
    .take(1);
  for (const item of work) {
    const operation = await ctx.db.get("GroupHierarchyOperation", item.operationId);
    if (operation?.kind === "remove" && operation.phase !== "cleaning") return operation;
  }
  return null;
}

async function activeHierarchyOperationForGroup(ctx: MutationCtx, groupId: Id<"Group">) {
  const work = await ctx.db
    .query("GroupHierarchyWork")
    .withIndex("group_id", (q) => q.eq("groupId", groupId))
    .first();
  return work === null ? null : await ctx.db.get("GroupHierarchyOperation", work.operationId);
}

async function assertGroupNotBeingRemoved(ctx: MutationCtx, groupId: Id<"Group">) {
  if ((await activeRemovalForGroup(ctx, groupId)) !== null) {
    throw new ConvexError({
      code: ErrorCode.INVALID_PARAMETERS,
      message: `Group ${groupId} is being removed and cannot be changed.`,
    });
  }
}

async function assertGroupCanAcceptChild(ctx: MutationCtx, groupId: Id<"Group">) {
  if ((await activeHierarchyOperationForGroup(ctx, groupId)) !== null) {
    throw new ConvexError({
      code: ErrorCode.INVALID_PARAMETERS,
      message: `Group ${groupId} has a hierarchy operation in progress and cannot accept a child.`,
    });
  }
}

async function planHierarchyOperation(ctx: MutationCtx, operation: Doc<"GroupHierarchyOperation">) {
  const items = await ctx.db
    .query("GroupHierarchyWork")
    .withIndex("operation_id_planned", (q) =>
      q.eq("operationId", operation._id).eq("planned", false),
    )
    .take(PLAN_ITEMS_PER_RUN);

  for (const item of items) {
    const page = await paginator(ctx.db, schema)
      .query("Group")
      .withIndex("parent_group_id", (q) => q.eq("parentGroupId", item.groupId))
      .paginate({ numItems: CHILDREN_PER_PAGE, cursor: item.scanCursor ?? null });
    for (const child of page.page) {
      const existing = await ctx.db
        .query("GroupHierarchyWork")
        .withIndex("operation_id_group_id", (q) =>
          q.eq("operationId", operation._id).eq("groupId", child._id),
        )
        .unique();
      if (existing === null) {
        await ctx.db.insert("GroupHierarchyWork", {
          operationId: operation._id,
          kind: operation.kind,
          groupId: child._id,
          parentWorkId: item._id,
          expectedParentGroupId: item.groupId,
          depth: item.depth + 1,
          planned: false,
          applied: false,
        });
      }
    }
    await ctx.db.patch("GroupHierarchyWork", item._id, {
      planned: page.isDone,
      scanCursor: page.isDone ? undefined : page.continueCursor,
    });
  }

  const pending = await ctx.db
    .query("GroupHierarchyWork")
    .withIndex("operation_id_planned", (q) =>
      q.eq("operationId", operation._id).eq("planned", false),
    )
    .first();
  if (pending === null) {
    await ctx.db.patch("GroupHierarchyOperation", operation._id, { phase: "applying" });
  }
  await scheduleHierarchyOperation(ctx, operation._id);
}

async function applyRemoval(ctx: MutationCtx, operation: Doc<"GroupHierarchyOperation">) {
  const items = await ctx.db
    .query("GroupHierarchyWork")
    .withIndex("operation_id_applied_depth", (q) =>
      q.eq("operationId", operation._id).eq("applied", false),
    )
    .order("desc")
    .take(APPLY_ITEMS_PER_RUN);

  for (const item of items) {
    const group = await ctx.db.get("Group", item.groupId);
    if (group === null) {
      await ctx.db.patch("GroupHierarchyWork", item._id, { applied: true });
      continue;
    }
    const children = await ctx.db
      .query("Group")
      .withIndex("parent_group_id", (q) => q.eq("parentGroupId", item.groupId))
      .take(2);
    let hasBlockingChild = false;
    for (const child of children) {
      const childWork = await ctx.db
        .query("GroupHierarchyWork")
        .withIndex("operation_id_group_id", (q) =>
          q.eq("operationId", operation._id).eq("groupId", child._id),
        )
        .unique();
      // A valid tree always discovers a child at depth + 1. A child already
      // discovered at this depth or shallower is the single back-edge of a
      // malformed parent cycle; ignoring only that edge lets the removal break
      // the cycle instead of scheduling forever.
      if (childWork === null || childWork.depth > item.depth) {
        hasBlockingChild = true;
        break;
      }
    }
    if (hasBlockingChild) continue;

    const members = await ctx.db
      .query("GroupMember")
      .withIndex("group_id", (q) => q.eq("groupId", item.groupId))
      .take(RELATIONS_PER_RUN);
    const invites = await ctx.db
      .query("GroupInvite")
      .withIndex("group_id", (q) => q.eq("groupId", item.groupId))
      .take(RELATIONS_PER_RUN);
    for (const member of members) await ctx.db.delete("GroupMember", member._id);
    for (const invite of invites) await ctx.db.delete("GroupInvite", invite._id);
    if (members.length === RELATIONS_PER_RUN || invites.length === RELATIONS_PER_RUN) continue;

    await ctx.db.delete("Group", item.groupId);
    await ctx.db.patch("GroupHierarchyWork", item._id, { applied: true });
  }

  const pending = await ctx.db
    .query("GroupHierarchyWork")
    .withIndex("operation_id_applied_depth", (q) =>
      q.eq("operationId", operation._id).eq("applied", false),
    )
    .first();
  if (pending === null) {
    await ctx.db.patch("GroupHierarchyOperation", operation._id, { phase: "cleaning" });
  }
  await scheduleHierarchyOperation(ctx, operation._id);
}

async function applyRestamp(ctx: MutationCtx, operation: Doc<"GroupHierarchyOperation">) {
  const newRootGroupId = operation.newRootGroupId;
  if (newRootGroupId === undefined) {
    await ctx.db.patch("GroupHierarchyOperation", operation._id, { phase: "cleaning" });
    await scheduleHierarchyOperation(ctx, operation._id);
    return;
  }
  const items = await ctx.db
    .query("GroupHierarchyWork")
    .withIndex("operation_id_applied_depth", (q) =>
      q.eq("operationId", operation._id).eq("applied", false),
    )
    .order("asc")
    .take(APPLY_ITEMS_PER_RUN);

  for (const item of items) {
    const group = await ctx.db.get("Group", item.groupId);
    let eligible = false;
    if (group !== null) {
      if (item.parentWorkId === undefined) {
        eligible =
          group.parentGroupId === operation.expectedParentGroupId &&
          group.rootGroupId === newRootGroupId;
      } else {
        const parentWork = await ctx.db.get("GroupHierarchyWork", item.parentWorkId);
        eligible =
          parentWork?.eligible === true && group.parentGroupId === item.expectedParentGroupId;
      }
      if (eligible && group.rootGroupId !== newRootGroupId) {
        await ctx.db.patch("Group", group._id, { rootGroupId: newRootGroupId });
      }
    }
    await ctx.db.patch("GroupHierarchyWork", item._id, { eligible, applied: true });
  }

  const pending = await ctx.db
    .query("GroupHierarchyWork")
    .withIndex("operation_id_applied_depth", (q) =>
      q.eq("operationId", operation._id).eq("applied", false),
    )
    .first();
  if (pending === null) {
    await ctx.db.patch("GroupHierarchyOperation", operation._id, { phase: "cleaning" });
  }
  await scheduleHierarchyOperation(ctx, operation._id);
}

async function cleanupHierarchyOperation(
  ctx: MutationCtx,
  operation: Doc<"GroupHierarchyOperation">,
) {
  const work = await ctx.db
    .query("GroupHierarchyWork")
    .withIndex("operation_id_group_id", (q) => q.eq("operationId", operation._id))
    .take(CLEANUP_ITEMS_PER_RUN);
  for (const item of work) await ctx.db.delete("GroupHierarchyWork", item._id);
  if (work.length === 0) {
    await ctx.db.delete("GroupHierarchyOperation", operation._id);
  } else {
    await scheduleHierarchyOperation(ctx, operation._id);
  }
}

/** Durable, idempotent continuation for large hierarchy operations. */
export const processGroupHierarchy = internalMutation({
  args: { operationId: v.id("GroupHierarchyOperation") },
  returns: v.null(),
  handler: async (ctx, { operationId }) => {
    const operation = await ctx.db.get("GroupHierarchyOperation", operationId);
    if (operation === null) return null;
    if (operation.phase === "planning") await planHierarchyOperation(ctx, operation);
    else if (operation.phase === "applying" && operation.kind === "remove") {
      await applyRemoval(ctx, operation);
    } else if (operation.phase === "applying") {
      await applyRestamp(ctx, operation);
    } else {
      await cleanupHierarchyOperation(ctx, operation);
    }
    return null;
  },
});

/**
 * Patch fields on a group. Re-parenting (a `patch.parentGroupId`) recomputes
 * `isRoot`/`rootGroupId` and cascades the new `rootGroupId` to every
 * descendant in the moved subtree. Small subtrees update atomically. Large
 * subtrees use a durable planned work queue; stale continuations verify their
 * target and parent lineage before writing, so a newer move always wins.
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
    await assertGroupNotBeingRemoved(ctx, groupId);
    if (patch.parentGroupId !== undefined) {
      await assertGroupCanAcceptChild(ctx, patch.parentGroupId);
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
      const existingRestamp = await ctx.db
        .query("GroupHierarchyOperation")
        .withIndex("group_id_kind_parent_root", (q) =>
          q
            .eq("groupId", groupId)
            .eq("kind", "restamp")
            .eq("expectedParentGroupId", newParentGroupId!)
            .eq("newRootGroupId", newRootGroupId),
        )
        .first();
      if (existingRestamp !== null) {
        await scheduleHierarchyOperation(ctx, existingRestamp._id);
      } else if (oldRootGroupId && oldRootGroupId !== newRootGroupId) {
        const inline = await collectInlineSubtree(ctx, groupId, false);
        if (inline === null) {
          await createHierarchyOperation(ctx, {
            groupId,
            kind: "restamp",
            newRootGroupId,
            expectedParentGroupId: newParentGroupId!,
          });
        } else {
          for (const group of inline.groups) {
            if (group._id !== groupId && group.rootGroupId !== newRootGroupId) {
              await ctx.db.patch("Group", group._id, { rootGroupId: newRootGroupId });
            }
          }
        }
      }
    }
    await ctx.db.patch("Group", groupId, patch);
    return null;
  },
});

/**
 * Delete a group and cascade-delete its descendant groups, memberships, and
 * invites. Small subtrees delete atomically. Large subtrees are fully planned
 * before application begins, then drained bottom-up through durable,
 * idempotent continuations. Retrying `remove` resumes the same operation.
 */
const remove = mutation({
  args: { id: v.id("Group") },
  returns: v.null(),
  handler: async (ctx, { id: groupId }) => {
    const exactOperation = await ctx.db
      .query("GroupHierarchyOperation")
      .withIndex("group_id_kind", (q) => q.eq("groupId", groupId).eq("kind", "remove"))
      .first();
    if (exactOperation !== null) {
      await scheduleHierarchyOperation(ctx, exactOperation._id);
      return null;
    }
    const ancestorOperation = await activeRemovalForGroup(ctx, groupId);
    if (ancestorOperation !== null) {
      await scheduleHierarchyOperation(ctx, ancestorOperation._id);
      return null;
    }
    if ((await ctx.db.get("Group", groupId)) === null) return null;

    const inline = await collectInlineSubtree(ctx, groupId, true);
    if (inline === null) {
      await createHierarchyOperation(ctx, { groupId, kind: "remove" });
      return null;
    }
    for (const member of inline.members) await ctx.db.delete("GroupMember", member._id);
    for (const invite of inline.invites) await ctx.db.delete("GroupInvite", invite._id);
    for (const group of [...inline.groups].reverse()) await ctx.db.delete("Group", group._id);
    return null;
  },
});

export { remove };
