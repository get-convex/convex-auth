/**
 * `component.connection.webhook.delivery.*` — queued webhook delivery attempts
 * (sub-resource of webhook).
 *
 * `list` is overloaded (`{ connectionId }` history or
 * `{ now }` ready-for-dispatch).
 *
 * @module
 */

import { Workpool, vOnCompleteArgs } from "@convex-dev/workpool";
import { paginationOptsValidator } from "convex/server";
import { v, type Infer } from "convex/values";
import { paginator } from "convex-helpers/server/pagination";

import { api, components, internal } from "../../_generated/api";
import type { Id } from "../../_generated/dataModel";
import { internalAction, internalMutation, internalQuery, mutation, query } from "../../functions";
import { unsafeFetchUrlReason } from "../../../shared/fetch/guard";
import { logMessage } from "../../../shared/log";
import {
  vAuthEventKind,
  vGroupWebhookDeliveryDoc,
  vGroupWebhookDeliveryPublicDoc,
  vPaginated,
  vWebhookDeliveryStatus,
} from "../../model";
import schema from "../../schema";

const MAX_ATTEMPTS = 5;

const workpool = new Workpool(components.webhookWorkpool, {
  maxParallelism: 5,
  defaultRetryBehavior: { maxAttempts: MAX_ATTEMPTS, initialBackoffMs: 1_000, base: 2 },
  retryActionsByDefault: true,
});

/**
 * Whether an HTTP response status warrants a retry. Only transient failures
 * retry — `5xx`, `408 Request Timeout`, and `429 Too Many Requests`. Every
 * other non-2xx (the rest of `4xx`, plus unfollowed `3xx`) is a permanent
 * rejection that re-sending the identical payload cannot fix, so it fails
 * immediately instead of burning the full retry budget.
 */
function isRetriableStatus(status: number): boolean {
  return status >= 500 || status === 408 || status === 429;
}

async function appendDeliveryEvent(
  ctx: any,
  args: {
    deliveryId: string;
    connectionId: string;
    endpointId: string;
    sourceEventId: string;
    sourceEventType: Infer<typeof vAuthEventKind>;
    kind:
      | "webhook.delivery.created"
      | "webhook.delivery.attempted"
      | "webhook.delivery.succeeded"
      | "webhook.delivery.failed";
    outcome: "success" | "failure";
    occurredAt: number;
    data?: Record<string, unknown>;
  },
) {
  const attemptPart =
    typeof args.data?.attemptCount === "number" ? `:${args.data.attemptCount}` : "";
  const event = {
    eventId: `${args.kind}:${args.deliveryId}${attemptPart}`,
    kind: args.kind,
    category: "webhook" as const,
    occurredAt: args.occurredAt,
    actor: { type: "webhook" as const, id: args.endpointId },
    subject: { type: "webhook_delivery" as const, id: args.deliveryId },
    targets: [{ kind: "connection" as const, id: args.connectionId }],
    outcome: args.outcome,
    data: {
      sourceEventId: args.sourceEventId,
      sourceEventType: args.sourceEventType,
      endpointId: args.endpointId,
      deliveryId: args.deliveryId,
      ...args.data,
    },
  };
  try {
    await ctx.runMutation(api.event.append, {
      event,
      targets: event.targets,
      idempotencyKey: event.eventId,
    });
  } catch (error) {
    logMessage("connection.webhook.delivery", "WARN", [
      `audit event ${args.kind} emit failed (best-effort)`,
      error,
    ]);
  }
}

function publicDelivery(
  delivery: Infer<typeof vGroupWebhookDeliveryDoc>,
): Infer<typeof vGroupWebhookDeliveryPublicDoc> {
  return {
    _id: delivery._id,
    _creationTime: delivery._creationTime,
    connectionId: delivery.connectionId,
    endpointId: delivery.endpointId,
    eventId: delivery.eventId,
    kind: delivery.kind,
    status: delivery.status,
    attemptCount: delivery.attemptCount,
    nextAttemptAt: delivery.nextAttemptAt,
    lastAttemptAt: delivery.lastAttemptAt,
    lastResponseStatus: delivery.lastResponseStatus,
    lastError: delivery.lastError,
    signedAt: delivery.signedAt,
  };
}

/** Read a delivery by id (internal — returns the full, unredacted doc). */
export const get = internalQuery({
  args: { id: v.id("GroupWebhookDelivery") },
  returns: v.union(vGroupWebhookDeliveryDoc, v.null()),
  handler: async (ctx, { id: deliveryId }) => {
    return await ctx.db.get("GroupWebhookDelivery", deliveryId);
  },
});

/** List a connection's deliveries, newest first and paginated. Rows are redacted to public fields. */
export const list = query({
  args: {
    connectionId: v.id("GroupConnection"),
    paginationOpts: paginationOptsValidator,
  },
  returns: vPaginated(vGroupWebhookDeliveryPublicDoc),
  handler: async (ctx, { connectionId, paginationOpts }) => {
    const result = await paginator(ctx.db, schema)
      .query("GroupWebhookDelivery")
      .withIndex("group_connection_id", (idx) => idx.eq("connectionId", connectionId))
      .order("desc")
      .paginate(paginationOpts);
    return {
      ...result,
      page: result.page.map(publicDelivery),
    };
  },
});

/**
 * List pending deliveries whose `nextAttemptAt` is at or before `now`, ready to
 * be dispatched (`limit` clamped to 1..100, default 50).
 */
export const dueForDispatch = query({
  args: {
    now: v.number(),
    limit: v.optional(v.number()),
  },
  returns: v.array(vGroupWebhookDeliveryDoc),
  handler: async (ctx, { now, limit }) => {
    const take = Math.min(Math.max(limit ?? 50, 1), 100);
    return await ctx.db
      .query("GroupWebhookDelivery")
      .withIndex("status_next_attempt_at", (idx) =>
        idx.eq("status", "pending").lte("nextAttemptAt", now),
      )
      .take(take);
  },
});

/**
 * Queue a delivery for an endpoint. Idempotent on `(eventId, endpointId)` —
 * returns the existing id if already queued. On insert, emits a
 * `webhook.delivery.created` audit event and enqueues the `dispatch` action on
 * the workpool (running at `nextAttemptAt`, with `onDispatchComplete` as the
 * completion hook).
 */
export const create = mutation({
  args: {
    connectionId: v.id("GroupConnection"),
    endpointId: v.id("GroupWebhookEndpoint"),
    eventId: v.string(),
    kind: vAuthEventKind,
    payload: v.any(),
    nextAttemptAt: v.number(),
    signature: v.string(),
    signedAt: v.number(),
  },
  returns: v.id("GroupWebhookDelivery"),
  handler: async (ctx, args) => {
    const existing = await ctx.db
      .query("GroupWebhookDelivery")
      .withIndex("event_id_endpoint_id", (idx) =>
        idx.eq("eventId", args.eventId).eq("endpointId", args.endpointId),
      )
      .unique();
    if (existing !== null) return existing._id;
    const deliveryId = await ctx.db.insert("GroupWebhookDelivery", {
      ...args,
      status: "pending",
      attemptCount: 0,
    });
    await appendDeliveryEvent(ctx, {
      deliveryId,
      connectionId: args.connectionId,
      endpointId: args.endpointId,
      sourceEventId: args.eventId,
      sourceEventType: args.kind,
      kind: "webhook.delivery.created",
      outcome: "success",
      occurredAt: args.signedAt,
    });
    await workpool.enqueueAction(
      ctx,
      internal.connection.webhook.delivery.dispatch,
      { id: deliveryId },
      {
        runAt: args.nextAttemptAt,
        onComplete: internal.connection.webhook.delivery.onDispatchComplete,
        context: { deliveryId },
      },
    );
    return deliveryId;
  },
});

/**
 * Workpool completion hook for a delivery's dispatch chain.
 *
 * Guarantees a terminal row state even when `dispatch` itself never reached its
 * own terminal branch — e.g. a bookkeeping mutation threw on every attempt, so
 * the workpool exhausted its retries while the row was left non-terminal. On any
 * non-success outcome, settle a still-open delivery as `failed`.
 */
export const onDispatchComplete = internalMutation({
  args: vOnCompleteArgs(v.object({ deliveryId: v.id("GroupWebhookDelivery") })),
  returns: v.null(),
  handler: async (ctx, { context, result }) => {
    if (result.kind === "success") return null;
    const delivery = await ctx.db.get("GroupWebhookDelivery", context.deliveryId);
    if (delivery === null || delivery.status === "delivered" || delivery.status === "failed") {
      return null;
    }
    await ctx.db.patch("GroupWebhookDelivery", context.deliveryId, {
      status: "failed",
      lastError: result.kind === "failed" ? result.error : "delivery canceled",
    });
    return null;
  },
});

/** Patch fields on a delivery (attempt bookkeeping). */
export const update = mutation({
  args: {
    id: v.id("GroupWebhookDelivery"),
    patch: v.object({
      status: v.optional(vWebhookDeliveryStatus),
      attemptCount: v.optional(v.number()),
      nextAttemptAt: v.optional(v.number()),
      lastAttemptAt: v.optional(v.number()),
      lastResponseStatus: v.optional(v.number()),
      lastError: v.optional(v.string()),
    }),
  },
  returns: v.null(),
  handler: async (ctx, { id: deliveryId, patch }) => {
    await ctx.db.patch("GroupWebhookDelivery", deliveryId, patch);
    return null;
  },
});

/**
 * POST a delivery's signed payload to its endpoint and settle the row. Skips
 * (failing the delivery) when the endpoint is missing or disabled. Marks
 * `delivered` on a 2xx; on failure, retries via the workpool until the attempt
 * budget is spent — only transient HTTP statuses (see `isRetriableStatus`) and
 * fetch errors are retried, everything else fails immediately. Emits
 * `attempted`/`succeeded`/`failed` audit events along the way.
 */
export const dispatch = internalAction({
  args: { id: v.id("GroupWebhookDelivery") },
  returns: v.null(),
  handler: async (ctx, { id: deliveryId }) => {
    const delivery = (await ctx.runQuery(internal.connection.webhook.delivery.get, {
      id: deliveryId,
    })) as {
      _id: string;
      connectionId: string;
      endpointId: string;
      eventId?: string;
      kind?: Infer<typeof vAuthEventKind>;
      payload: unknown;
      status: Infer<typeof vWebhookDeliveryStatus>;
      attemptCount: number;
      signature?: string;
      signedAt?: number;
    } | null;
    if (!delivery) return null;

    // At-least-once delivery. The workpool can re-invoke `dispatch` for a
    // delivery whose previous attempt already settled — a retry scheduled
    // before a sibling attempt committed its terminal status, a re-enqueue
    // after a crash, or an `onDispatchComplete` that already failed the row.
    // Re-read the row and bail before POSTing again once it is terminal, so a
    // delivered/failed delivery is never re-sent. A crash in the narrow window
    // between the POST and the status write still re-delivers, so receivers get
    // at-least-once (not exactly-once) semantics and MUST dedup on the stable
    // `X-Auth-Delivery-Id` header sent below.
    if (delivery.status === "delivered" || delivery.status === "failed") {
      return null;
    }

    if (
      delivery.eventId === undefined ||
      delivery.kind === undefined ||
      delivery.signature === undefined ||
      delivery.signedAt === undefined
    ) {
      const failedAt = Date.now();
      await ctx.runMutation(api.connection.webhook.delivery.update, {
        id: deliveryId,
        patch: {
          status: "failed",
          lastError: "legacy delivery is missing signed event fields",
          lastAttemptAt: failedAt,
          attemptCount: delivery.attemptCount + 1,
        },
      });
      return null;
    }

    const endpoint = (await ctx.runQuery(api.connection.webhook.endpoint.get, {
      id: delivery.endpointId as Id<"GroupWebhookEndpoint">,
    })) as { url: string; status: string } | null;
    if (!endpoint || endpoint.status !== "active") {
      const failedAt = Date.now();
      await appendDeliveryEvent(ctx, {
        deliveryId,
        connectionId: delivery.connectionId,
        endpointId: delivery.endpointId,
        sourceEventId: delivery.eventId,
        sourceEventType: delivery.kind,
        kind: "webhook.delivery.failed",
        outcome: "failure",
        occurredAt: failedAt,
        data: {
          attemptCount: delivery.attemptCount + 1,
          error: "endpoint missing or disabled",
        },
      });
      await ctx.runMutation(api.connection.webhook.delivery.update, {
        id: deliveryId,
        patch: {
          status: "failed",
          lastError: "endpoint missing or disabled",
          lastAttemptAt: failedAt,
          attemptCount: delivery.attemptCount + 1,
        },
      });
      return null;
    }

    const startedAt = Date.now();
    await appendDeliveryEvent(ctx, {
      deliveryId,
      connectionId: delivery.connectionId,
      endpointId: delivery.endpointId,
      sourceEventId: delivery.eventId,
      sourceEventType: delivery.kind,
      kind: "webhook.delivery.attempted",
      outcome: "success",
      occurredAt: startedAt,
      data: { attemptCount: delivery.attemptCount + 1 },
    });
    const body = JSON.stringify({
      kind: delivery.kind,
      payload: delivery.payload,
    });
    let response: Response;
    try {
      const unsafeUrlReason = unsafeFetchUrlReason(endpoint.url);
      if (unsafeUrlReason !== null) {
        throw new Error(`Webhook ${unsafeUrlReason}`);
      }
      response = await fetch(endpoint.url, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Auth-Event-Type": delivery.kind,
          "X-Auth-Delivery-Id": delivery._id,
          "X-Auth-Timestamp": String(delivery.signedAt),
          "X-Auth-Signature": `sha256=${delivery.signature}`,
        },
        body,
        redirect: "manual",
        signal: AbortSignal.timeout(15_000),
      });
    } catch (err) {
      const exhausted = delivery.attemptCount + 1 >= MAX_ATTEMPTS;
      await appendDeliveryEvent(ctx, {
        deliveryId,
        connectionId: delivery.connectionId,
        endpointId: delivery.endpointId,
        sourceEventId: delivery.eventId,
        sourceEventType: delivery.kind,
        kind: "webhook.delivery.failed",
        outcome: "failure",
        occurredAt: startedAt,
        data: {
          attemptCount: delivery.attemptCount + 1,
          error: err instanceof Error ? err.message : String(err),
        },
      });
      await ctx.runMutation(api.connection.webhook.delivery.update, {
        id: deliveryId,
        patch: {
          status: exhausted ? "failed" : "processing",
          lastError: err instanceof Error ? err.message : String(err),
          lastAttemptAt: startedAt,
          attemptCount: delivery.attemptCount + 1,
        },
      });
      if (!exhausted) throw err;
      return null;
    }

    if (!response.ok) {
      const terminal =
        !isRetriableStatus(response.status) || delivery.attemptCount + 1 >= MAX_ATTEMPTS;
      await appendDeliveryEvent(ctx, {
        deliveryId,
        connectionId: delivery.connectionId,
        endpointId: delivery.endpointId,
        sourceEventId: delivery.eventId,
        sourceEventType: delivery.kind,
        kind: "webhook.delivery.failed",
        outcome: "failure",
        occurredAt: startedAt,
        data: {
          attemptCount: delivery.attemptCount + 1,
          status: response.status,
        },
      });
      await ctx.runMutation(api.connection.webhook.delivery.update, {
        id: deliveryId,
        patch: {
          status: terminal ? "failed" : "processing",
          lastResponseStatus: response.status,
          lastError: `HTTP ${response.status}`,
          lastAttemptAt: startedAt,
          attemptCount: delivery.attemptCount + 1,
        },
      });
      if (!terminal) throw new Error(`Webhook delivery failed: HTTP ${response.status}`);
      return null;
    }

    await appendDeliveryEvent(ctx, {
      deliveryId,
      connectionId: delivery.connectionId,
      endpointId: delivery.endpointId,
      sourceEventId: delivery.eventId,
      sourceEventType: delivery.kind,
      kind: "webhook.delivery.succeeded",
      outcome: "success",
      occurredAt: startedAt,
      data: {
        attemptCount: delivery.attemptCount + 1,
        status: response.status,
      },
    });
    await ctx.runMutation(api.connection.webhook.delivery.update, {
      id: deliveryId,
      patch: {
        status: "delivered",
        lastResponseStatus: response.status,
        lastAttemptAt: startedAt,
        attemptCount: delivery.attemptCount + 1,
      },
    });
    return null;
  },
});
