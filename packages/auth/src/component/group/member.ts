/**
 * `component.group.member.*` — group memberships (sub-resource of group).
 *
 * `get` is overloaded — single lookup or, with `{ userId, groupIds }`,
 * a batched resolve aligned to input order. `resolve` is a domain read
 * (hierarchy-aware membership resolution).
 *
 * @module
 */

import { paginationOptsValidator } from "convex/server";
import { ConvexError, v } from "convex/values";
import { stream } from "convex-helpers/server/stream";
import { ErrorCode } from "../../shared/codes";

import type { Id } from "../_generated/dataModel";
import { mutation, query } from "../functions";
import { vGroupMemberDoc, vPaginated } from "../model";
import schema from "../schema";

/**
 * Read a membership by `id`, by `{ groupId, userId }`, or — with
 * `{ userId, groupIds }` — batch-read one user's memberships across many
 * groups (result aligned to input order, `null` where absent).
 */
export const get = query({
  args: {
    id: v.optional(v.id("GroupMember")),
    groupId: v.optional(v.id("Group")),
    userId: v.optional(v.id("User")),
    groupIds: v.optional(v.array(v.id("Group"))),
  },
  returns: v.union(vGroupMemberDoc, v.null(), v.array(v.union(vGroupMemberDoc, v.null()))),
  handler: async (ctx, args) => {
    if (args.userId !== undefined && args.groupIds !== undefined) {
      const groupIds = args.groupIds;
      if (groupIds.length === 0) return [];
      const unique = Array.from(new Set(groupIds));
      const docs = await Promise.all(
        unique.map((groupId) =>
          ctx.db
            .query("GroupMember")
            .withIndex("group_id_user_id", (q) =>
              q.eq("groupId", groupId).eq("userId", args.userId!),
            )
            .unique(),
        ),
      );
      const byGroupId = new Map(unique.map((id, i) => [id, docs[i] ?? null]));
      return groupIds.map((id) => byGroupId.get(id) ?? null);
    }
    if (args.groupId !== undefined && args.userId !== undefined) {
      return await ctx.db
        .query("GroupMember")
        .withIndex("group_id_user_id", (q) =>
          q.eq("groupId", args.groupId!).eq("userId", args.userId!),
        )
        .unique();
    }
    if (args.id === undefined) return null;
    return await ctx.db.get("GroupMember", args.id);
  },
});

/** List memberships, paginated, optionally filtered by `where` and sorted via `orderBy`/`order`. */
export const list = query({
  args: {
    where: v.optional(
      v.object({
        groupId: v.optional(v.id("Group")),
        userId: v.optional(v.id("User")),
        status: v.optional(v.string()),
      }),
    ),
    paginationOpts: paginationOptsValidator,
    orderBy: v.optional(v.union(v.literal("_creationTime"), v.literal("status"))),
    order: v.optional(v.union(v.literal("asc"), v.literal("desc"))),
  },
  returns: vPaginated(vGroupMemberDoc),
  handler: async (ctx, args) => {
    const where = args.where ?? {};
    const order = args.order ?? "desc";
    const orderBy = args.orderBy ?? "_creationTime";

    const base = stream(ctx.db, schema).query("GroupMember");
    let q;
    // Choose the index whose sort suffix matches `orderBy`. `.order()` sorts by
    // the index's trailing column(s), so `orderBy: "status"` needs an index that
    // ends in `status` (`group_id_status`, with `groupId` pinned) — otherwise the
    // `orderBy` is silently ignored and results come back in `_creationTime` order.
    if (orderBy === "status" && where.groupId !== undefined) {
      // group_id_status keys on (groupId, status, _creationTime); pinning groupId
      // orders the page by status. A `status` filter is applied via filterWith so
      // the ordering column is still status (not collapsed to one value).
      q = base.withIndex("group_id_status", (idx) => idx.eq("groupId", where.groupId!));
    } else if (where.groupId !== undefined && where.userId !== undefined) {
      q = base.withIndex("group_id_user_id", (idx) =>
        idx.eq("groupId", where.groupId!).eq("userId", where.userId!),
      );
    } else if (where.groupId !== undefined && where.status !== undefined) {
      q = base.withIndex("group_id_status", (idx) =>
        idx.eq("groupId", where.groupId!).eq("status", where.status!),
      );
    } else if (where.groupId !== undefined) {
      q = base.withIndex("group_id", (idx) => idx.eq("groupId", where.groupId!));
    } else if (where.userId !== undefined) {
      q = base.withIndex("user_id", (idx) => idx.eq("userId", where.userId!));
    } else {
      q = base;
    }

    const needStatusFilter =
      where.status !== undefined &&
      !(where.groupId !== undefined && where.userId === undefined && orderBy !== "status");

    return await q
      .order(order)
      .filterWith(async (d) => !needStatusFilter || d.status === where.status)
      .paginate(args.paginationOpts);
  },
});

/**
 * Insert a new membership, rejecting a duplicate for the same
 * `{ groupId, userId }` with `DUPLICATE_MEMBERSHIP`.
 */
export const create = mutation({
  args: {
    groupId: v.id("Group"),
    userId: v.id("User"),
    roleIds: v.optional(v.array(v.string())),
    status: v.optional(v.string()),
    extend: v.optional(v.any()),
  },
  returns: v.id("GroupMember"),
  handler: async (ctx, args) => {
    const existingMembership = await ctx.db
      .query("GroupMember")
      .withIndex("group_id_user_id", (q) => q.eq("groupId", args.groupId).eq("userId", args.userId))
      .unique();
    if (existingMembership !== null) {
      throw new ConvexError({
        code: ErrorCode.DUPLICATE_MEMBERSHIP,
        message: "User is already a member of this group",
        groupId: args.groupId,
        userId: args.userId,
        existingMemberId: existingMembership._id,
      });
    }
    return await ctx.db.insert("GroupMember", args);
  },
});

/** Patch fields on a membership. */
export const update = mutation({
  args: {
    id: v.id("GroupMember"),
    patch: v.object({
      role: v.optional(v.string()),
      roleIds: v.optional(v.array(v.string())),
      status: v.optional(v.string()),
      extend: v.optional(v.any()),
    }),
  },
  returns: v.null(),
  handler: async (ctx, { id: memberId, patch }) => {
    await ctx.db.patch("GroupMember", memberId, patch);
    return null;
  },
});

/** Delete a membership. */
const remove = mutation({
  args: { id: v.id("GroupMember") },
  returns: v.null(),
  handler: async (ctx, { id: memberId }) => {
    await ctx.db.delete("GroupMember", memberId);
    return null;
  },
});

export { remove };

/**
 * Resolve a user's effective membership in a group, walking up the parent
 * chain so an ancestor membership is inherited by descendants. Returns the
 * matched membership plus where it was found (`matchedGroupId`, `depth`,
 * `isDirect`/`isInherited`); `ancestry: true` also reports the
 * `traversedGroupIds`. All match fields are null when no membership exists.
 */
export const resolve = query({
  args: {
    userId: v.id("User"),
    groupId: v.id("Group"),
    maxDepth: v.optional(v.number()),
    ancestry: v.optional(v.boolean()),
  },
  returns: v.object({
    membership: v.union(vGroupMemberDoc, v.null()),
    matchedGroupId: v.union(v.id("Group"), v.null()),
    depth: v.union(v.number(), v.null()),
    isDirect: v.boolean(),
    isInherited: v.boolean(),
    traversedGroupIds: v.optional(v.array(v.id("Group"))),
  }),
  handler: async (ctx, args) => {
    const maxDepth = Math.max(0, Math.floor(args.maxDepth ?? 32));
    const includeAncestry = args.ancestry ?? false;
    const visited = new Set<string>();
    const traversedGroupIds: Id<"Group">[] = [];
    let currentGroupId: Id<"Group"> | undefined = args.groupId;
    let depth = 0;

    while (currentGroupId !== undefined && depth <= maxDepth) {
      if (visited.has(currentGroupId)) break;
      visited.add(currentGroupId);
      if (includeAncestry) traversedGroupIds.push(currentGroupId);

      const membership = await ctx.db
        .query("GroupMember")
        .withIndex("group_id_user_id", (q) =>
          q.eq("groupId", currentGroupId!).eq("userId", args.userId),
        )
        .unique();

      if (membership !== null) {
        return {
          membership,
          matchedGroupId: currentGroupId,
          depth,
          isDirect: depth === 0,
          isInherited: depth > 0,
          ...(includeAncestry ? { traversedGroupIds } : {}),
        };
      }

      const groupDoc: { parentGroupId?: Id<"Group"> } | null = await ctx.db.get(
        "Group",
        currentGroupId,
      );
      if (!groupDoc?.parentGroupId) break;
      currentGroupId = groupDoc.parentGroupId;
      depth++;
    }

    return {
      membership: null,
      matchedGroupId: null,
      depth: null,
      isDirect: false,
      isInherited: false,
      ...(includeAncestry ? { traversedGroupIds } : {}),
    };
  },
});
