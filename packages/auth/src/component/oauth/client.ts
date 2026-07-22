/**
 * `component.oauth.client.*` — OAuth 2.1 client registration.
 *
 * Reads collapse into one overloaded `get`.
 *
 * @module
 */

import { paginationOptsValidator } from "convex/server";
import { ConvexError, v } from "convex/values";
import { paginator } from "convex-helpers/server/pagination";
import { ErrorCode } from "../../shared/codes";

import { internal } from "../_generated/api";
import { internalMutation, mutation, query } from "../functions";
import { vOAuthClientDoc, vPaginated, vTokenEndpointAuthMethod } from "../model";
import schema from "../schema";

/**
 * Read a client by identity. Accepts exactly one selector:
 * - `{ id }`       → `Doc<"OAuthClient"> | null`
 * - `{ clientId }` → `Doc<"OAuthClient"> | null`
 */
export const get = query({
  args: {
    id: v.optional(v.id("OAuthClient")),
    clientId: v.optional(v.string()),
  },
  returns: v.union(vOAuthClientDoc, v.null()),
  handler: async (ctx, args) => {
    if (args.clientId !== undefined) {
      return await ctx.db
        .query("OAuthClient")
        .withIndex("client_id", (q) => q.eq("clientId", args.clientId!))
        .first();
    }
    if (args.id === undefined) return null;
    return await ctx.db.get("OAuthClient", args.id);
  },
});

/**
 * Register a new OAuth client (created un-revoked). Returns the new id.
 *
 * When `allowedScopes` is supplied (RFC 7591 DCR self-registration), the
 * requested `scopes` are clamped to that server ceiling before persistence, so a
 * self-registering client can never grant itself a scope the authorization
 * server does not offer. This is defense-in-depth at the persistence boundary;
 * the DCR HTTP register handler also clamps up front. Omit it for trusted admin
 * creation, which may set any scope. `allowedScopes` is a filter only — it is
 * never stored on the client document.
 */
export const create = mutation({
  args: {
    clientId: v.string(),
    clientSecretHash: v.optional(v.string()),
    name: v.string(),
    redirectUris: v.array(v.string()),
    scopes: v.array(v.string()),
    grantTypes: v.array(v.string()),
    tokenEndpointAuthMethod: v.optional(vTokenEndpointAuthMethod),
    registrationAccessTokenHash: v.optional(v.string()),
    createdBy: v.optional(v.id("User")),
    extend: v.optional(v.any()),
    allowedScopes: v.optional(v.array(v.string())),
  },
  returns: v.id("OAuthClient"),
  handler: async (ctx, args) => {
    const { allowedScopes, ...rest } = args;
    const scopes =
      allowedScopes === undefined
        ? rest.scopes
        : rest.scopes.filter((scope) => allowedScopes.includes(scope));
    return await ctx.db.insert("OAuthClient", { ...rest, scopes, revoked: false });
  },
});

/**
 * Replace an OAuth client's mutable registration metadata (RFC 7592 `PUT`).
 * Looks the client up by `clientId`; throws if absent. Setting the method to
 * `none` also clears any stored `clientSecretHash` so a downgraded client can
 * never be authenticated by a stale secret.
 */
export const update = mutation({
  args: {
    clientId: v.string(),
    patch: v.object({
      name: v.optional(v.string()),
      redirectUris: v.optional(v.array(v.string())),
      scopes: v.optional(v.array(v.string())),
      grantTypes: v.optional(v.array(v.string())),
      tokenEndpointAuthMethod: v.optional(vTokenEndpointAuthMethod),
    }),
  },
  returns: v.null(),
  handler: async (ctx, { clientId, patch }) => {
    const doc = await ctx.db
      .query("OAuthClient")
      .withIndex("client_id", (q) => q.eq("clientId", clientId))
      .first();
    if (doc === null) {
      throw new ConvexError({ code: ErrorCode.OAUTH_CLIENT_NOT_FOUND, clientId });
    }
    const next: Record<string, unknown> = { ...patch };
    if (patch.tokenEndpointAuthMethod === "none") next.clientSecretHash = undefined;
    await ctx.db.patch("OAuthClient", doc._id, next);
    return null;
  },
});

/**
 * Page over OAuth clients, optionally scoped by `createdBy`. Archived clients
 * are excluded unless `where.includeRevoked` is set.
 */
export const list = query({
  args: {
    where: v.optional(
      v.object({
        createdBy: v.optional(v.id("User")),
        includeRevoked: v.optional(v.boolean()),
      }),
    ),
    paginationOpts: paginationOptsValidator,
  },
  returns: vPaginated(vOAuthClientDoc),
  handler: async (ctx, args) => {
    const where = args.where ?? {};
    const includeRevoked = where.includeRevoked === true;
    const base = paginator(ctx.db, schema).query("OAuthClient");
    const q =
      where.createdBy !== undefined && !includeRevoked
        ? base.withIndex("created_by_revoked", (idx) =>
            idx.eq("createdBy", where.createdBy!).eq("revoked", false),
          )
        : where.createdBy !== undefined
          ? base.withIndex("created_by", (idx) => idx.eq("createdBy", where.createdBy!))
          : !includeRevoked
            ? base.withIndex("revoked", (idx) => idx.eq("revoked", false))
            : base;
    return await q.paginate(args.paginationOpts);
  },
});

/** Soft-delete a client by `clientId` (sets `revoked`); throws if not found. */
export const revoke = mutation({
  args: { clientId: v.string() },
  returns: v.null(),
  handler: async (ctx, { clientId }) => {
    const doc = await ctx.db
      .query("OAuthClient")
      .withIndex("client_id", (q) => q.eq("clientId", clientId))
      .first();
    if (doc === null) {
      throw new ConvexError({ code: ErrorCode.OAUTH_CLIENT_NOT_FOUND, clientId });
    }
    await ctx.db.patch("OAuthClient", doc._id, {
      revoked: true,
      revokedAt: doc.revokedAt ?? Date.now(),
    });
    return null;
  },
});

/**
 * Hard-delete a client by `clientId`. Unlike {@link revoke} (a reversible
 * soft-delete that keeps the row for audit), this permanently removes the
 * registration row. Throws `OAUTH_CLIENT_NOT_FOUND` if absent.
 */
const remove = mutation({
  args: { clientId: v.string() },
  returns: v.null(),
  handler: async (ctx, { clientId }) => {
    const doc = await ctx.db
      .query("OAuthClient")
      .withIndex("client_id", (q) => q.eq("clientId", clientId))
      .first();
    if (doc === null) {
      throw new ConvexError({ code: ErrorCode.OAUTH_CLIENT_NOT_FOUND, clientId });
    }
    await ctx.db.delete("OAuthClient", doc._id);
    return null;
  },
});

export { remove };

/** Default (and hard cap) batch size for {@link prune}. */
const OAUTH_CLIENT_PRUNE_BATCH = 100;

/** Keep revoked registrations for audit before hard deletion. */
const OAUTH_CLIENT_RETENTION_MS = 90 * 24 * 60 * 60 * 1000;

/**
 * Retention GC for revoked OAuth clients: hard-deletes a bounded batch of
 * revoked registrations whose `revokedAt` is before `before` (defaults to the
 * 90-day audit-retention cutoff), oldest first. RFC 7591 dynamic client
 * registration is self-service and otherwise
 * unbounded, so a soft {@link revoke} alone lets dead rows accumulate forever;
 * the mutation self-reschedules while eligible rows remain.
 *
 * Internal (cron-driven): kept off the public component surface so a mounting
 * app cannot invoke a bulk delete, mirroring `maintenance.pruneExpired`.
 *
 * Legacy revoked rows without `revokedAt` fail closed (they are retained) until
 * `backfillOAuthClientRevokedAt` stamps them, starting their retention clock.
 */
export const prune = internalMutation({
  args: {
    before: v.optional(v.number()),
    limit: v.optional(v.number()),
  },
  returns: v.object({ deleted: v.number() }),
  handler: async (ctx, args) => {
    const before = args.before ?? Date.now() - OAUTH_CLIENT_RETENTION_MS;
    const limit = Math.max(
      1,
      Math.min(args.limit ?? OAUTH_CLIENT_PRUNE_BATCH, OAUTH_CLIENT_PRUNE_BATCH),
    );
    const revokedClients = await ctx.db
      .query("OAuthClient")
      .withIndex("revoked_at", (q) =>
        q.eq("revoked", true).gt("revokedAt", undefined).lt("revokedAt", before),
      )
      .take(limit + 1);
    const toDelete = revokedClients.slice(0, limit);
    for (const doc of toDelete) {
      await ctx.db.delete("OAuthClient", doc._id);
    }
    if (revokedClients.length > limit) {
      await ctx.scheduler.runAfter(0, internal.oauth.client.prune, { before, limit });
    }
    return { deleted: toDelete.length };
  },
});
