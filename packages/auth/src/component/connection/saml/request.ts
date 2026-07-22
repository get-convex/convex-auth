/**
 * `component.connection.saml.request.*` — pending SAML AuthnRequest IDs
 * (sub-resource of connection) enabling server-side replay prevention.
 *
 * A row is persisted when the SP generates a sign-in request and accepted
 * single-use at the ACS handler. Because `accept` is one atomic
 * read-check-write mutation, a captured SAMLResponse/RelayState pair cannot be
 * replayed - the second accept fails.
 *
 * @module
 */

import { v } from "convex/values";

import { mutation } from "../../functions";

/** Persist a pending SAML AuthnRequest ID so the ACS handler can accept it once. */
export const create = mutation({
  args: {
    connectionId: v.id("GroupConnection"),
    requestId: v.string(),
    createdAt: v.number(),
    expiresAt: v.number(),
  },
  returns: v.id("SamlLoginRequest"),
  handler: async (ctx, args) => {
    return await ctx.db.insert("SamlLoginRequest", args);
  },
});

/**
 * Atomically accept a pending SAML AuthnRequest by its `requestId`. Returns
 * `true` only when a matching, unaccepted, unexpired row existed and was
 * stamped `acceptedAt`; a replayed, expired, or unknown request returns
 * `false`.
 *
 * When `connectionId` is supplied, the pending request must also belong to that
 * connection. This is defense-in-depth for multi-tenant setups: a `SAMLResponse`
 * captured under one connection carries an `InResponseTo` that must not be
 * consumable while processing a *different* connection's ACS callback. A
 * mismatch returns `false` *without* consuming the row, so the owning
 * connection can still accept it (a wrong-connection probe cannot burn a
 * legitimate pending request).
 */
export const accept = mutation({
  args: {
    requestId: v.string(),
    now: v.number(),
    connectionId: v.optional(v.id("GroupConnection")),
  },
  returns: v.boolean(),
  handler: async (ctx, { requestId, now, connectionId }) => {
    const row = await ctx.db
      .query("SamlLoginRequest")
      .withIndex("request_id", (idx) => idx.eq("requestId", requestId))
      .first();
    if (row === null || row.acceptedAt !== undefined || row.expiresAt <= now) {
      return false;
    }
    if (connectionId !== undefined && row.connectionId !== connectionId) {
      return false;
    }
    await ctx.db.patch("SamlLoginRequest", row._id, { acceptedAt: now });
    return true;
  },
});
