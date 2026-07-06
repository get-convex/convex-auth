/**
 * `component.connection.domain.*` — domains linked to an Connection
 * connection (sub-resource of connection).
 *
 * `verify` is a kept domain verb (ownership-proof
 * workflow); ownership-record CRUD nests under `domain.verification`.
 *
 * @module
 */

import { ConvexError, v } from "convex/values";
import { ErrorCode } from "../../shared/codes";

import { mutation, query } from "../functions";
import { vGroupConnectionDomainDoc } from "../model";

const CONNECTION_DOMAIN_BATCH = 500;

/** List the domains attached to a connection (`limit` clamped to 1..500, default 100). */
export const list = query({
  args: {
    connectionId: v.id("GroupConnection"),
    limit: v.optional(v.number()),
  },
  returns: v.array(vGroupConnectionDomainDoc),
  handler: async (ctx, { connectionId, limit }) => {
    const bounded = Math.min(Math.max(limit ?? 100, 1), 500);
    return await ctx.db
      .query("GroupConnectionDomain")
      .withIndex("connection_id", (idx) => idx.eq("connectionId", connectionId))
      .take(bounded);
  },
});

/**
 * Attach a domain to a connection. Idempotent on `(connectionId, domain)`:
 * re-attaching patches the existing row instead of inserting. Throws if the
 * domain already belongs to a different connection. Setting `isPrimary` demotes
 * any current primary; the first domain on a connection becomes primary by default.
 */
export const create = mutation({
  args: {
    connectionId: v.id("GroupConnection"),
    groupId: v.id("Group"),
    domain: v.string(),
    isPrimary: v.optional(v.boolean()),
  },
  returns: v.id("GroupConnectionDomain"),
  handler: async (ctx, args) => {
    const { connectionId, ...rest } = args;
    const existingByDomain = await ctx.db
      .query("GroupConnectionDomain")
      .withIndex("domain", (idx) => idx.eq("domain", args.domain))
      .first();
    if (existingByDomain && existingByDomain.connectionId !== connectionId) {
      throw new ConvexError({
        code: ErrorCode.GROUP_CONNECTION_DOMAIN_TAKEN,
        message: "That domain is already attached to another connection.",
      });
    }

    const existingForConnection = await ctx.db
      .query("GroupConnectionDomain")
      .withIndex("connection_id", (q) => q.eq("connectionId", connectionId))
      .take(CONNECTION_DOMAIN_BATCH + 1);
    if (existingForConnection.length > CONNECTION_DOMAIN_BATCH) {
      throw new ConvexError({
        code: ErrorCode.CASCADE_TOO_LARGE,
        message: `Connection has more than ${CONNECTION_DOMAIN_BATCH} domains; update is not safe in one mutation.`,
      });
    }

    for (const row of existingForConnection) {
      if (row.domain === args.domain) {
        if (args.isPrimary === true) {
          for (const other of existingForConnection) {
            if (other._id !== row._id && other.isPrimary) {
              await ctx.db.patch("GroupConnectionDomain", other._id, { isPrimary: false });
            }
          }
        }
        await ctx.db.patch("GroupConnectionDomain", row._id, {
          isPrimary: args.isPrimary ?? row.isPrimary,
        });
        return row._id;
      }
    }

    if (args.isPrimary === true) {
      for (const row of existingForConnection) {
        if (row.isPrimary) {
          await ctx.db.patch("GroupConnectionDomain", row._id, { isPrimary: false });
        }
      }
    }

    return await ctx.db.insert("GroupConnectionDomain", {
      connectionId: connectionId,
      ...rest,
      isPrimary: args.isPrimary ?? existingForConnection.length === 0,
    });
  },
});

/** Delete a domain and its dependent verification record, if any. */
const remove = mutation({
  args: { id: v.id("GroupConnectionDomain") },
  returns: v.null(),
  handler: async (ctx, { id: domainId }) => {
    const verification = await ctx.db
      .query("GroupConnectionDomainVerification")
      .withIndex("domain_id", (idx) => idx.eq("domainId", domainId))
      .first();
    if (verification) {
      await ctx.db.delete("GroupConnectionDomainVerification", verification._id);
    }
    await ctx.db.delete("GroupConnectionDomain", domainId);
    return null;
  },
});

export { remove };

/**
 * Mark a domain verified at `verifiedAt` and clear its pending verification
 * record. Returns the updated domain doc.
 */
export const verify = mutation({
  args: {
    id: v.id("GroupConnectionDomain"),
    verifiedAt: v.number(),
  },
  returns: vGroupConnectionDomainDoc,
  handler: async (ctx, { id: domainId, verifiedAt }) => {
    await ctx.db.patch("GroupConnectionDomain", domainId, { verifiedAt });
    const domain = await ctx.db.get("GroupConnectionDomain", domainId);
    if (!domain) {
      throw new ConvexError({
        code: ErrorCode.INVALID_PARAMETERS,
        message: "Group Connection domain not found.",
      });
    }
    const verification = await ctx.db
      .query("GroupConnectionDomainVerification")
      .withIndex("domain_id", (idx) => idx.eq("domainId", domainId))
      .first();
    if (verification) {
      await ctx.db.delete("GroupConnectionDomainVerification", verification._id);
    }
    return domain;
  },
});
