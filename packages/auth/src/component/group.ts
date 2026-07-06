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

import type { Doc, Id } from "./_generated/dataModel";
import { mutation, query } from "./functions";
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

/**
 * Patch fields on a group. Re-parenting (a `patch.parentGroupId`) recomputes
 * `isRoot`/`rootGroupId` and cascades the new `rootGroupId` to every
 * descendant in the moved subtree.
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
        const CASCADE_MAX = 1000;
        const visited = new Set<string>([groupId]);
        const frontier: Array<Id<"Group">> = [groupId];
        while (frontier.length > 0) {
          const parentId = frontier.pop()!;
          const children = await ctx.db
            .query("Group")
            .withIndex("parent_group_id", (q) => q.eq("parentGroupId", parentId))
            .take(CASCADE_MAX + 1);
          if (children.length > CASCADE_MAX) {
            throw new ConvexError({
              code: ErrorCode.CASCADE_TOO_LARGE,
              message: `Group ${parentId} has more than ${CASCADE_MAX} child groups; re-parent re-stamping is not safe in a single mutation. Drain via the migrations component first, then retry.`,
            });
          }
          for (const child of children) {
            if (visited.has(child._id)) continue;
            visited.add(child._id);
            await ctx.db.patch("Group", child._id, {
              rootGroupId: newRootGroupId,
            });
            frontier.push(child._id);
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
 * invites. Refuses (throwing `CASCADE_TOO_LARGE`) when any table exceeds the
 * per-mutation cascade limit, so a large subtree must be drained via the
 * migrations component first.
 */
const remove = mutation({
  args: { id: v.id("Group") },
  returns: v.null(),
  handler: async (ctx, { id: groupId }) => {
    const CASCADE_MAX = 1000;
    const refuseOverflow = (id: Id<"Group">, table: string, count: number) => {
      if (count > CASCADE_MAX) {
        throw new ConvexError({
          code: ErrorCode.CASCADE_TOO_LARGE,
          message: `Group ${id} has more than ${CASCADE_MAX} rows in ${table}; cascade delete is not safe in a single mutation. Drain via the migrations component first, then retry.`,
        });
      }
    };

    const visited = new Set<string>([groupId]);
    const frontier: Array<Id<"Group">> = [groupId];
    while (frontier.length > 0) {
      const id = frontier.pop()!;

      const children = await ctx.db
        .query("Group")
        .withIndex("parent_group_id", (q) => q.eq("parentGroupId", id))
        .take(CASCADE_MAX + 1);
      refuseOverflow(id, "Group(children)", children.length);
      for (const child of children) {
        if (visited.has(child._id)) continue;
        visited.add(child._id);
        frontier.push(child._id);
      }

      const members = await ctx.db
        .query("GroupMember")
        .withIndex("group_id", (q) => q.eq("groupId", id))
        .take(CASCADE_MAX + 1);
      refuseOverflow(id, "GroupMember", members.length);
      for (const member of members) {
        await ctx.db.delete("GroupMember", member._id);
      }

      const invites = await ctx.db
        .query("GroupInvite")
        .withIndex("group_id", (q) => q.eq("groupId", id))
        .take(CASCADE_MAX + 1);
      refuseOverflow(id, "GroupInvite", invites.length);
      for (const invite of invites) {
        await ctx.db.delete("GroupInvite", invite._id);
      }

      await ctx.db.delete("Group", id);
    }

    return null;
  },
});

export { remove };
