/**
 * `component.connection.webhook.endpoint.*` — webhook endpoint registrations
 * for Connection event delivery.
 *
 * @module
 */

import { v } from "convex/values";

import { mutation, query } from "../../functions";
import { vAuthEventKind, vGroupWebhookEndpointDoc, vWebhookEndpointStatus } from "../../model";

const WEBHOOK_ENDPOINT_LIST_BATCH = 128;

/** Read a webhook endpoint by id. */
export const get = query({
  args: { id: v.id("GroupWebhookEndpoint") },
  returns: v.union(vGroupWebhookEndpointDoc, v.null()),
  handler: async (ctx, { id: endpointId }) => {
    return await ctx.db.get("GroupWebhookEndpoint", endpointId);
  },
});

/** List a connection's webhook endpoints. */
export const list = query({
  args: { connectionId: v.id("GroupConnection") },
  returns: v.array(vGroupWebhookEndpointDoc),
  handler: async (ctx, { connectionId }) => {
    return await ctx.db
      .query("GroupWebhookEndpoint")
      .withIndex("group_connection_id", (q) => q.eq("connectionId", connectionId))
      .take(WEBHOOK_ENDPOINT_LIST_BATCH);
  },
});

/** Insert a new webhook endpoint (defaults `status` to `"active"`, `failureCount` to 0). */
export const create = mutation({
  args: {
    connectionId: v.id("GroupConnection"),
    groupId: v.id("Group"),
    url: v.string(),
    status: v.optional(vWebhookEndpointStatus),
    secretCiphertext: v.string(),
    subscriptions: v.array(vAuthEventKind),
    createdByUserId: v.optional(v.id("User")),
    extend: v.optional(v.any()),
  },
  returns: v.id("GroupWebhookEndpoint"),
  handler: async (ctx, args) => {
    return await ctx.db.insert("GroupWebhookEndpoint", {
      ...args,
      status: args.status ?? "active",
      failureCount: 0,
    });
  },
});

/** Patch fields on a webhook endpoint. */
export const update = mutation({
  args: {
    id: v.id("GroupWebhookEndpoint"),
    patch: v.object({
      url: v.optional(v.string()),
      status: v.optional(vWebhookEndpointStatus),
      secretCiphertext: v.optional(v.string()),
      subscriptions: v.optional(v.array(vAuthEventKind)),
      lastSuccessAt: v.optional(v.number()),
      lastFailureAt: v.optional(v.number()),
      failureCount: v.optional(v.number()),
      extend: v.optional(v.any()),
    }),
  },
  returns: v.null(),
  handler: async (ctx, { id: endpointId, patch }) => {
    await ctx.db.patch("GroupWebhookEndpoint", endpointId, patch);
    return null;
  },
});
