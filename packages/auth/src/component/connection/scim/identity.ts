/**
 * `component.connection.scim.identity.*` — SCIM-provisioned
 * identities for an Connection connection (sub-resource of connection).
 *
 * `get` is overloaded — single lookup or, with `{ connectionId,
 * userIds }`, a batched resolve aligned to input order.
 *
 * @module
 */

import { paginationOptsValidator } from "convex/server";
import { ConvexError, v } from "convex/values";
import { paginator } from "convex-helpers/server/pagination";

import { ErrorCode } from "../../../shared/codes";
import { mutation, query } from "../../functions";
import { vGroupConnectionScimIdentityDoc, vPaginated, vScimResourceType } from "../../model";
import schema from "../../schema";

const vScimUserData = v.object(schema.tables.User.validator.fields);

/**
 * Read SCIM identities, overloaded by the args supplied. With
 * `{ connectionId, userIds }` it batch-resolves and returns an array aligned to
 * the input order (`null` per missing user). Otherwise it resolves a single
 * identity by `(connectionId, resourceType, externalId)`, `(connectionId,
 * userId)`, `userId`, or `mappedGroupId`. Returns `null` when nothing matches.
 */
export const get = query({
  args: {
    connectionId: v.optional(v.id("GroupConnection")),
    resourceType: v.optional(vScimResourceType),
    externalId: v.optional(v.string()),
    userId: v.optional(v.id("User")),
    userIds: v.optional(v.array(v.id("User"))),
    mappedGroupId: v.optional(v.id("Group")),
  },
  returns: v.union(
    vGroupConnectionScimIdentityDoc,
    v.null(),
    v.array(v.union(vGroupConnectionScimIdentityDoc, v.null())),
  ),
  handler: async (ctx, args) => {
    if (args.connectionId !== undefined && args.userIds !== undefined) {
      const userIds = args.userIds;
      if (userIds.length === 0) return [];
      const unique = Array.from(new Set(userIds));
      const docs = await Promise.all(
        unique.map((userId) =>
          ctx.db
            .query("GroupConnectionScimIdentity")
            .withIndex("group_connection_id_user_id", (idx) =>
              idx.eq("connectionId", args.connectionId!).eq("userId", userId),
            )
            .first(),
        ),
      );
      const byUserId = new Map(unique.map((id, i) => [id, docs[i] ?? null]));
      return userIds.map((userId) => byUserId.get(userId) ?? null);
    }
    if (
      args.connectionId !== undefined &&
      args.resourceType !== undefined &&
      args.externalId !== undefined
    ) {
      return await ctx.db
        .query("GroupConnectionScimIdentity")
        .withIndex("group_connection_id_resource_type_external_id", (idx) =>
          idx
            .eq("connectionId", args.connectionId!)
            .eq("resourceType", args.resourceType!)
            .eq("externalId", args.externalId!),
        )
        .first();
    }
    if (args.connectionId !== undefined && args.userId !== undefined) {
      return await ctx.db
        .query("GroupConnectionScimIdentity")
        .withIndex("group_connection_id_user_id", (idx) =>
          idx.eq("connectionId", args.connectionId!).eq("userId", args.userId!),
        )
        .first();
    }
    if (args.userId !== undefined) {
      return await ctx.db
        .query("GroupConnectionScimIdentity")
        .withIndex("user_id", (idx) => idx.eq("userId", args.userId!))
        .first();
    }
    if (args.mappedGroupId !== undefined) {
      return await ctx.db
        .query("GroupConnectionScimIdentity")
        .withIndex("mapped_group_id", (idx) => idx.eq("mappedGroupId", args.mappedGroupId!))
        .first();
    }
    return null;
  },
});

/** List a connection's SCIM identities, paginated. */
export const list = query({
  args: {
    connectionId: v.id("GroupConnection"),
    paginationOpts: paginationOptsValidator,
  },
  returns: vPaginated(vGroupConnectionScimIdentityDoc),
  handler: async (ctx, { connectionId, paginationOpts }) => {
    return await paginator(ctx.db, schema)
      .query("GroupConnectionScimIdentity")
      .withIndex("group_connection_id", (idx) => idx.eq("connectionId", connectionId))
      .paginate(paginationOpts);
  },
});

/** Insert a SCIM identity, or patch it when it already exists (keyed by `(connectionId, resourceType, externalId)`). */
export const upsert = mutation({
  args: {
    connectionId: v.id("GroupConnection"),
    groupId: v.id("Group"),
    resourceType: vScimResourceType,
    externalId: v.string(),
    userId: v.optional(v.id("User")),
    mappedGroupId: v.optional(v.id("Group")),
    lastProvisionedAt: v.optional(v.number()),
    active: v.optional(v.boolean()),
    raw: v.optional(v.any()),
  },
  returns: v.id("GroupConnectionScimIdentity"),
  handler: async (ctx, args) => {
    const existing = await ctx.db
      .query("GroupConnectionScimIdentity")
      .withIndex("group_connection_id_resource_type_external_id", (idx) =>
        idx
          .eq("connectionId", args.connectionId)
          .eq("resourceType", args.resourceType)
          .eq("externalId", args.externalId),
      )
      .first();
    if (existing) {
      await ctx.db.patch("GroupConnectionScimIdentity", existing._id, args);
      return existing._id;
    }
    return await ctx.db.insert("GroupConnectionScimIdentity", args);
  },
});

/**
 * Atomically provision or resolve a SCIM user by both of its durable natural
 * keys: the connection-scoped SCIM external id and the provider Account id.
 * A concurrent retry cannot commit a losing User because the identity and
 * Account index reads participate in the same OCC transaction as the inserts.
 * Existing ownership is preserved; conflicting owners are rejected.
 */
export const provision = mutation({
  args: {
    connectionId: v.id("GroupConnection"),
    groupId: v.id("Group"),
    externalId: v.string(),
    provider: v.string(),
    userData: vScimUserData,
    lastProvisionedAt: v.optional(v.number()),
    active: v.optional(v.boolean()),
    raw: v.optional(v.any()),
  },
  returns: v.object({
    userId: v.id("User"),
    created: v.boolean(),
  }),
  handler: async (ctx, args) => {
    const identity = await ctx.db
      .query("GroupConnectionScimIdentity")
      .withIndex("group_connection_id_resource_type_external_id", (idx) =>
        idx
          .eq("connectionId", args.connectionId)
          .eq("resourceType", "user")
          .eq("externalId", args.externalId),
      )
      .unique();
    const account = await ctx.db
      .query("Account")
      .withIndex("provider_account_id", (idx) =>
        idx.eq("provider", args.provider).eq("providerAccountId", args.externalId),
      )
      .unique();

    if (identity?.userId !== undefined && account !== null && identity.userId !== account.userId) {
      throw new ConvexError({
        code: ErrorCode.ACCOUNT_ALREADY_LINKED,
        message: "The SCIM identity and provider account belong to different users.",
      });
    }

    const existingUserId = identity?.userId ?? account?.userId;
    let userId = existingUserId;
    let created = false;
    if (userId !== undefined) {
      const user = await ctx.db.get("User", userId);
      if (user === null) {
        throw new ConvexError({
          code: ErrorCode.ACCOUNT_NOT_FOUND,
          message: "The SCIM identity references a user that no longer exists.",
        });
      }
    } else {
      userId = await ctx.db.insert("User", args.userData);
      created = true;
    }

    if (account === null) {
      await ctx.db.insert("Account", {
        userId,
        provider: args.provider,
        providerAccountId: args.externalId,
      });
    }

    const identityData = {
      connectionId: args.connectionId,
      groupId: args.groupId,
      resourceType: "user" as const,
      externalId: args.externalId,
      userId,
      ...(args.lastProvisionedAt !== undefined
        ? { lastProvisionedAt: args.lastProvisionedAt }
        : {}),
      ...(args.active !== undefined ? { active: args.active } : {}),
      ...(args.raw !== undefined ? { raw: args.raw } : {}),
    };
    if (identity === null) {
      await ctx.db.insert("GroupConnectionScimIdentity", identityData);
    } else {
      await ctx.db.patch("GroupConnectionScimIdentity", identity._id, identityData);
    }

    return { userId, created };
  },
});

/** Delete a SCIM identity by id. */
const remove = mutation({
  args: { id: v.id("GroupConnectionScimIdentity") },
  returns: v.null(),
  handler: async (ctx, { id: identityId }) => {
    await ctx.db.delete("GroupConnectionScimIdentity", identityId);
    return null;
  },
});

export { remove };
