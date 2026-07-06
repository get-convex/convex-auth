/**
 * `component.connection.*` — Connection group connections (the connection
 * entity root; domains/secrets/SCIM are sub-resources nested under it).
 *
 * Reads collapse into one overloaded `get`
 * (`{ id }` → doc, `{ domain }` → `{ connection, domain }`).
 *
 * @module
 */

import { paginationOptsValidator } from "convex/server";
import { ConvexError, v } from "convex/values";
import { stream } from "convex-helpers/server/stream";

import { ErrorCode } from "../shared/codes";
import { internal } from "./_generated/api";
import type { Id } from "./_generated/dataModel";
import type { MutationCtx } from "./_generated/server";
import { internalMutation, mutation, query } from "./functions";
import {
  vGroupConnectionDoc,
  vGroupConnectionDomainDoc,
  vGroupConnectionProtocol,
  vGroupConnectionStatus,
  vPaginated,
} from "./model";
import schema from "./schema";

/**
 * Read a connection. Overloaded: `{ id }` returns the connection doc;
 * `{ domain }` resolves the owning connection and returns
 * `{ connection, domain }`. Returns `null` when nothing matches.
 *
 * Domain resolution only ever matches a **verified** domain (`verifiedAt`
 * set): an unverified/pending domain must not influence login routing or
 * account linking, or any tenant could claim another's domain (with no
 * DNS-TXT proof) and hijack its users. Domains are unique per row, so the
 * first verified match is the owner.
 */
export const get = query({
  args: {
    id: v.optional(v.id("GroupConnection")),
    domain: v.optional(v.string()),
  },
  returns: v.union(
    vGroupConnectionDoc,
    v.object({
      connection: vGroupConnectionDoc,
      domain: vGroupConnectionDomainDoc,
    }),
    v.null(),
  ),
  handler: async (ctx, args) => {
    if (args.domain !== undefined) {
      const domainRows = await ctx.db
        .query("GroupConnectionDomain")
        .withIndex("domain", (idx) => idx.eq("domain", args.domain!))
        .take(DOMAIN_RESOLVE_MAX);
      const domainRow = domainRows.find((row) => row.verifiedAt !== undefined);
      if (!domainRow) {
        return null;
      }
      const connection = await ctx.db.get("GroupConnection", domainRow.connectionId);
      if (!connection) {
        return null;
      }
      return { connection, domain: domainRow };
    }
    if (args.id === undefined) return null;
    return await ctx.db.get("GroupConnection", args.id);
  },
});

/** List connections, paginated. Filters by `groupId`, `slug`, and/or `status`; orders by the chosen field. */
export const list = query({
  args: {
    where: v.optional(
      v.object({
        groupId: v.optional(v.id("Group")),
        slug: v.optional(v.string()),
        status: v.optional(vGroupConnectionStatus),
      }),
    ),
    paginationOpts: paginationOptsValidator,
    orderBy: v.optional(
      v.union(
        v.literal("_creationTime"),
        v.literal("name"),
        v.literal("slug"),
        v.literal("status"),
      ),
    ),
    order: v.optional(v.union(v.literal("asc"), v.literal("desc"))),
  },
  returns: vPaginated(vGroupConnectionDoc),
  handler: async (ctx, args) => {
    const where = args.where ?? {};
    const order = args.order ?? "desc";
    const orderBy = args.orderBy ?? "_creationTime";

    const base = stream(ctx.db, schema).query("GroupConnection");
    let q;
    if (orderBy === "name") {
      q =
        where.groupId !== undefined
          ? base.withIndex("group_id_name", (idx) => idx.eq("groupId", where.groupId!))
          : base.withIndex("name");
    } else if (orderBy === "slug") {
      q =
        where.groupId !== undefined
          ? where.slug !== undefined
            ? base.withIndex("group_id_slug", (idx) =>
                idx.eq("groupId", where.groupId!).eq("slug", where.slug!),
              )
            : base.withIndex("group_id_slug", (idx) => idx.eq("groupId", where.groupId!))
          : where.slug !== undefined
            ? base.withIndex("slug", (idx) => idx.eq("slug", where.slug!))
            : base.withIndex("slug");
    } else if (orderBy === "status") {
      q =
        where.groupId !== undefined
          ? where.status !== undefined
            ? base.withIndex("group_id_status", (idx) =>
                idx.eq("groupId", where.groupId!).eq("status", where.status!),
              )
            : base.withIndex("group_id_status", (idx) => idx.eq("groupId", where.groupId!))
          : where.status !== undefined
            ? base.withIndex("status", (idx) => idx.eq("status", where.status!))
            : base.withIndex("status");
    } else if (where.groupId !== undefined && where.status !== undefined) {
      q = base.withIndex("group_id_status", (idx) =>
        idx.eq("groupId", where.groupId!).eq("status", where.status!),
      );
    } else if (where.groupId !== undefined && where.slug !== undefined) {
      q = base.withIndex("group_id_slug", (idx) =>
        idx.eq("groupId", where.groupId!).eq("slug", where.slug!),
      );
    } else if (where.groupId !== undefined) {
      q = base.withIndex("group_id", (idx) => idx.eq("groupId", where.groupId!));
    } else if (where.slug !== undefined) {
      q = base.withIndex("slug", (idx) => idx.eq("slug", where.slug!));
    } else if (where.status !== undefined) {
      q = base.withIndex("status", (idx) => idx.eq("status", where.status!));
    } else {
      q = base;
    }

    return await q
      .order(order)
      .filterWith(
        async (d) =>
          (where.groupId === undefined || d.groupId === where.groupId) &&
          (where.slug === undefined || d.slug === where.slug) &&
          (where.status === undefined || d.status === where.status),
      )
      .paginate(args.paginationOpts);
  },
});

/** Insert a new connection (defaults `status` to `"draft"`). */
export const create = mutation({
  args: {
    groupId: v.id("Group"),
    slug: v.optional(v.string()),
    name: v.optional(v.string()),
    protocol: vGroupConnectionProtocol,
    status: v.optional(vGroupConnectionStatus),
    config: v.optional(v.any()),
    extend: v.optional(v.any()),
  },
  returns: v.id("GroupConnection"),
  handler: async (ctx, args) => {
    return await ctx.db.insert("GroupConnection", {
      ...args,
      status: args.status ?? "draft",
    });
  },
});

/** Patch fields on a connection. */
export const update = mutation({
  args: {
    id: v.id("GroupConnection"),
    patch: v.object({
      slug: v.optional(v.string()),
      name: v.optional(v.string()),
      status: v.optional(vGroupConnectionStatus),
      config: v.optional(v.any()),
      extend: v.optional(v.any()),
    }),
  },
  returns: v.null(),
  handler: async (ctx, { id: connectionId, patch }) => {
    await ctx.db.patch("GroupConnection", connectionId, patch);
    return null;
  },
});

/**
 * Bound on rows scanned when resolving a connection by domain. A domain is
 * unique per row (`domain.create` rejects cross-connection reuse), so this only
 * guards against legacy duplicates while the verified-row filter is applied.
 */
const DOMAIN_RESOLVE_MAX = 16;

const CASCADE_MAX = 1000;
const SCIM_CONFIG_DELETE_BATCH = 16;
const CONNECTION_SECRET_DELETE_BATCH = 32;

async function purgeConnectionDependents(
  ctx: MutationCtx,
  connectionId: Id<"GroupConnection">,
): Promise<boolean> {
  let hasMore = false;

  const identities = await ctx.db
    .query("GroupConnectionScimIdentity")
    .withIndex("group_connection_id", (q) => q.eq("connectionId", connectionId))
    .take(CASCADE_MAX + 1);
  for (const row of identities.slice(0, CASCADE_MAX)) {
    await ctx.db.delete("GroupConnectionScimIdentity", row._id);
  }
  hasMore = hasMore || identities.length > CASCADE_MAX;

  const deliveries = await ctx.db
    .query("GroupWebhookDelivery")
    .withIndex("group_connection_id", (q) => q.eq("connectionId", connectionId))
    .take(CASCADE_MAX + 1);
  for (const row of deliveries.slice(0, CASCADE_MAX)) {
    await ctx.db.delete("GroupWebhookDelivery", row._id);
  }
  hasMore = hasMore || deliveries.length > CASCADE_MAX;

  const endpoints = await ctx.db
    .query("GroupWebhookEndpoint")
    .withIndex("group_connection_id", (q) => q.eq("connectionId", connectionId))
    .take(CASCADE_MAX + 1);
  for (const row of endpoints.slice(0, CASCADE_MAX)) {
    await ctx.db.delete("GroupWebhookEndpoint", row._id);
  }
  hasMore = hasMore || endpoints.length > CASCADE_MAX;

  const verifications = await ctx.db
    .query("GroupConnectionDomainVerification")
    .withIndex("connection_id", (q) => q.eq("connectionId", connectionId))
    .take(CASCADE_MAX + 1);
  for (const row of verifications.slice(0, CASCADE_MAX)) {
    await ctx.db.delete("GroupConnectionDomainVerification", row._id);
  }
  hasMore = hasMore || verifications.length > CASCADE_MAX;

  const domains = await ctx.db
    .query("GroupConnectionDomain")
    .withIndex("connection_id", (q) => q.eq("connectionId", connectionId))
    .take(CASCADE_MAX + 1);
  for (const row of domains.slice(0, CASCADE_MAX)) {
    await ctx.db.delete("GroupConnectionDomain", row._id);
  }
  hasMore = hasMore || domains.length > CASCADE_MAX;

  return hasMore;
}

/**
 * Delete a connection and every row that depends on it. The SCIM config (its
 * bearer-token hash) and the connection secrets are deleted in full and first —
 * there is at most one SCIM config and a fixed handful of secrets per
 * connection, so no inbound credential can outlive the connection. Every other
 * dependent (SCIM identities, webhook endpoints and deliveries, domains and
 * their verification challenges) is drained up to `CASCADE_MAX` per transaction
 * by {@link purgeConnectionDependents}; any backlog is finished by a scheduled
 * `purgeConnectionData` continuation, so even a connection with large tenant
 * data never exceeds a single mutation's read/write limits (an unbounded
 * collect would otherwise throw and roll the whole delete back, leaving the
 * credentials live).
 */
const remove = mutation({
  args: { id: v.id("GroupConnection") },
  returns: v.null(),
  handler: async (ctx, { id: connectionId }) => {
    const scimConfigs = await ctx.db
      .query("GroupConnectionScimConfig")
      .withIndex("group_connection_id", (q) => q.eq("connectionId", connectionId))
      .take(SCIM_CONFIG_DELETE_BATCH + 1);
    if (scimConfigs.length > SCIM_CONFIG_DELETE_BATCH) {
      throw new ConvexError({
        code: ErrorCode.CASCADE_TOO_LARGE,
        message: `Connection has more than ${SCIM_CONFIG_DELETE_BATCH} SCIM config rows; delete is not safe.`,
      });
    }
    for (const scimConfig of scimConfigs) {
      await ctx.db.delete("GroupConnectionScimConfig", scimConfig._id);
    }
    const secrets = await ctx.db
      .query("GroupConnectionSecret")
      .withIndex("connection_id", (q) => q.eq("connectionId", connectionId))
      .take(CONNECTION_SECRET_DELETE_BATCH + 1);
    if (secrets.length > CONNECTION_SECRET_DELETE_BATCH) {
      throw new ConvexError({
        code: ErrorCode.CASCADE_TOO_LARGE,
        message: `Connection has more than ${CONNECTION_SECRET_DELETE_BATCH} secret rows; delete is not safe.`,
      });
    }
    for (const secret of secrets) {
      await ctx.db.delete("GroupConnectionSecret", secret._id);
    }

    const hasMore = await purgeConnectionDependents(ctx, connectionId);
    await ctx.db.delete("GroupConnection", connectionId);
    if (hasMore) {
      await ctx.scheduler.runAfter(0, internal.connection.purgeConnectionData, { connectionId });
    }
    return null;
  },
});

/**
 * Continuation for {@link remove}: drains any connection-dependent rows left
 * past the per-transaction cascade cap, rescheduling itself until none remain.
 * The connection row, its SCIM config and its secrets are already deleted by the
 * time this runs, so the leftover rows are inert and reference a connection that
 * no longer exists.
 */
export const purgeConnectionData = internalMutation({
  args: { connectionId: v.id("GroupConnection") },
  returns: v.null(),
  handler: async (ctx, { connectionId }) => {
    const hasMore = await purgeConnectionDependents(ctx, connectionId);
    if (hasMore) {
      await ctx.scheduler.runAfter(0, internal.connection.purgeConnectionData, { connectionId });
    }
    return null;
  },
});

export { remove };
