/**
 * `component.event.*` - stream-backed auth events and queryable projections.
 *
 * @module
 */

import { defineStream } from "@convex-dev/stream";
import { paginator } from "convex-helpers/server/pagination";
import { paginationOptsValidator } from "convex/server";
import { ConvexError, v, type Infer } from "convex/values";

import { components, internal } from "./_generated/api";
import type { Doc } from "./_generated/dataModel";
import { ErrorCode } from "../shared/codes";
import { internalMutation, mutation, query } from "./functions";
import {
  vAuthEvent,
  vAuthEventData,
  vAuthEventProjectionDoc,
  vAuthEventTarget,
  vAuthEventWhere,
  vPaginated,
} from "./model";
import schema from "./schema";

type AuthEvent = Infer<typeof vAuthEvent>;
type AuthEventTarget = Infer<typeof vAuthEventTarget>;
type AuthEventWhere = Infer<typeof vAuthEventWhere>;

const authEventStream = defineStream(components.stream, {
  name: "auth",
  event: vAuthEvent,
});

const PRODUCER = { id: "auth", epoch: 0 } as const;

/** Whole auth events drained into the stream per `drainPending` invocation. */
const DRAIN_BATCH = 25;
const MAX_EVENT_TARGETS = 64;

function targetKey(target: AuthEventTarget): string {
  return `${target.kind}:${target.id}`;
}

const PUBLIC_DATA_KEYS = {
  user: ["type", "provider", "existingUserId"],
  session: ["provider", "method", "reason"],
  account: ["provider", "accountId"],
  password: ["userId"],
  passkey: ["passkeyId"],
  totp: ["totpId"],
  email: ["userId"],
  phone: ["userId"],
  api_key: ["keyId", "name", "prefix", "reason"],
  oauth: ["clientId", "codeId", "name", "scopes", "grantType", "resource", "userId"],
  connection: [
    "connectionId",
    "changed",
    "protocol",
    "domain",
    "recordName",
    "expiresAt",
    "verifiedAt",
    "metadataUrl",
    "domains",
    "version",
    "errorCode",
    "issuer",
    "discoveryUrl",
    "jwksUri",
    "audience",
    "tokenEndpointAuthMethod",
  ],
  scim: [
    "scimConfigId",
    "resourceType",
    "resourceId",
    "operation",
    "externalId",
    "active",
    "groupId",
    "userId",
  ],
  webhook: [
    "endpointId",
    "deliveryId",
    "sourceEventId",
    "sourceEventType",
    "attemptCount",
    "status",
    "error",
  ],
  security: ["reason", "errorCode"],
} as const;

const EVENT_KIND_DATA_CATEGORY: Record<AuthEvent["kind"], keyof typeof PUBLIC_DATA_KEYS> = {
  "user.created": "user",
  "user.updated": "user",
  "session.signed_in": "session",
  "session.signed_out": "session",
  "session.invalidated": "session",
  "session.refresh_exchanged": "session",
  "session.refresh_reuse_detected": "session",
  "account.linked": "account",
  "account.unlinked": "account",
  "password.changed": "password",
  "passkey.added": "passkey",
  "passkey.removed": "passkey",
  "totp.enrolled": "totp",
  "totp.removed": "totp",
  "email.verified": "email",
  "phone.verified": "phone",
  "api_key.created": "api_key",
  "api_key.revoked": "api_key",
  "oauth.client.created": "oauth",
  "oauth.client.revoked": "oauth",
  "oauth.code.created": "oauth",
  "oauth.token.created": "oauth",
  "oauth.token.exchanged": "oauth",
  "oauth.refresh.reuse_detected": "oauth",
  "oauth.refresh.revoked": "oauth",
  "connection.created": "connection",
  "connection.updated": "connection",
  "connection.removed": "connection",
  "connection.login.succeeded": "connection",
  "connection.login.failed": "connection",
  "connection.domain.verification_requested": "connection",
  "connection.domain.verified": "connection",
  "connection.policy.updated": "connection",
  "connection.saml.set": "connection",
  "connection.saml.refreshed": "connection",
  "connection.oidc.set": "connection",
  "connection.scim.set": "scim",
  "connection.scim.read": "scim",
  "connection.scim.user.provisioned": "scim",
  "connection.scim.user.updated": "scim",
  "connection.scim.user.deactivated": "scim",
  "connection.scim.user.reactivated": "scim",
  "connection.scim.group.provisioned": "scim",
  "connection.scim.group.updated": "scim",
  "connection.scim.group.deactivated": "scim",
  "connection.scim.group.reactivated": "scim",
  "webhook.endpoint.created": "webhook",
  "webhook.endpoint.disabled": "webhook",
  "webhook.delivery.created": "webhook",
  "webhook.delivery.attempted": "webhook",
  "webhook.delivery.succeeded": "webhook",
  "webhook.delivery.failed": "webhook",
};

function publicData(
  kind: AuthEvent["kind"],
  value: unknown,
): Infer<typeof vAuthEventData> | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined;
  const category = EVENT_KIND_DATA_CATEGORY[kind];
  const keys = PUBLIC_DATA_KEYS[category] ?? [];
  const source = value as Record<string, unknown>;
  const redacted: Record<string, unknown> = {};
  for (const key of keys) {
    const nested = source[key];
    if (nested !== undefined) redacted[key] = nested;
  }
  return Object.keys(redacted).length === 0
    ? undefined
    : (redacted as Infer<typeof vAuthEventData>);
}

function publicProjection(doc: Doc<"AuthEventProjection">): Infer<typeof vAuthEventProjectionDoc> {
  return {
    _id: doc._id,
    _creationTime: doc._creationTime,
    eventId: doc.eventId,
    targetKind: doc.targetKind,
    targetId: doc.targetId,
    kind: doc.kind,
    category: doc.category,
    occurredAt: doc.occurredAt,
    actorType: doc.actorType,
    actorId: doc.actorId,
    subjectType: doc.subjectType,
    subjectId: doc.subjectId,
    outcome: doc.outcome,
    errorCode: doc.errorCode,
    requestId: doc.requestId,
    ip: undefined,
    data: publicData(doc.kind, doc.data),
  };
}

function lowerBound(where: AuthEventWhere) {
  if (where.occurredAtGt !== undefined) return { op: "gt" as const, value: where.occurredAtGt };
  if (where.occurredAtGte !== undefined) return { op: "gte" as const, value: where.occurredAtGte };
  return null;
}

function upperBound(where: AuthEventWhere) {
  if (where.occurredAtLt !== undefined) return { op: "lt" as const, value: where.occurredAtLt };
  if (where.occurredAtLte !== undefined) return { op: "lte" as const, value: where.occurredAtLte };
  return null;
}

function applyTimeBounds(q: any, where: AuthEventWhere) {
  const lower = lowerBound(where);
  const upper = upperBound(where);
  if (lower?.op === "gt") q = q.gt("occurredAt", lower.value);
  if (lower?.op === "gte") q = q.gte("occurredAt", lower.value);
  if (upper?.op === "lt") q = q.lt("occurredAt", upper.value);
  if (upper?.op === "lte") q = q.lte("occurredAt", upper.value);
  return q;
}

function projectionQuery(ctx: any, where: AuthEventWhere) {
  const selectors = [
    where.target !== undefined ? "target" : null,
    where.kind !== undefined ? "kind" : null,
    where.category !== undefined ? "category" : null,
    where.outcome !== undefined ? "outcome" : null,
    where.actor !== undefined ? "actor" : null,
    where.subject !== undefined ? "subject" : null,
    where.requestId !== undefined ? "requestId" : null,
  ].filter((value): value is string => value !== null);
  const supported =
    selectors.length === 1 ||
    (where.target !== undefined &&
      selectors.every(
        (selector) => selector === "target" || selector === "kind" || selector === "outcome",
      ));
  if (!supported) {
    throw new ConvexError({
      code: ErrorCode.INVALID_PARAMETERS,
      message:
        "event.list filters must match an event projection index: target, target+kind, target+outcome, target+kind+outcome, or one of kind/category/outcome/actor/subject/requestId.",
    });
  }
  const db = paginator(ctx, schema).query("AuthEventProjection");
  if (where.target !== undefined) {
    if (where.kind !== undefined && where.outcome !== undefined) {
      return db.withIndex("target_kind_outcome_time", (q) =>
        applyTimeBounds(
          q
            .eq("targetKind", where.target!.kind)
            .eq("targetId", where.target!.id)
            .eq("kind", where.kind!)
            .eq("outcome", where.outcome!),
          where,
        ),
      );
    }
    if (where.kind !== undefined) {
      return db.withIndex("target_kind_time", (q) =>
        applyTimeBounds(
          q
            .eq("targetKind", where.target!.kind)
            .eq("targetId", where.target!.id)
            .eq("kind", where.kind!),
          where,
        ),
      );
    }
    if (where.outcome !== undefined) {
      return db.withIndex("target_outcome_time", (q) =>
        applyTimeBounds(
          q
            .eq("targetKind", where.target!.kind)
            .eq("targetId", where.target!.id)
            .eq("outcome", where.outcome!),
          where,
        ),
      );
    }
    return db.withIndex("target_time", (q) =>
      applyTimeBounds(
        q.eq("targetKind", where.target!.kind).eq("targetId", where.target!.id),
        where,
      ),
    );
  }
  if (where.kind !== undefined) {
    return db.withIndex("kind_time", (q) => applyTimeBounds(q.eq("kind", where.kind!), where));
  }
  if (where.category !== undefined) {
    return db.withIndex("category_time", (q) =>
      applyTimeBounds(q.eq("category", where.category!), where),
    );
  }
  if (where.outcome !== undefined) {
    return db.withIndex("outcome_time", (q) =>
      applyTimeBounds(q.eq("outcome", where.outcome!), where),
    );
  }
  if (where.actor !== undefined) {
    return db.withIndex("actor_time", (q) =>
      applyTimeBounds(q.eq("actorType", where.actor!.type).eq("actorId", where.actor!.id), where),
    );
  }
  if (where.subject !== undefined) {
    return db.withIndex("subject_time", (q) =>
      applyTimeBounds(
        q.eq("subjectType", where.subject!.type).eq("subjectId", where.subject!.id),
        where,
      ),
    );
  }
  if (where.requestId !== undefined) {
    return db.withIndex("request_id_time", (q) =>
      applyTimeBounds(q.eq("requestId", where.requestId!), where),
    );
  }
  throw new ConvexError({
    code: ErrorCode.INVALID_PARAMETERS,
    message:
      "event.list requires an indexed filter: target, kind, category, outcome, actor, subject, or requestId.",
  });
}

/** Read a single event projection by id, redacted to its public shape. */
export const get = query({
  args: { id: v.id("AuthEventProjection") },
  returns: v.union(vAuthEventProjectionDoc, v.null()),
  handler: async (ctx, { id }) => {
    const doc = await ctx.db.get("AuthEventProjection", id);
    return doc === null ? null : publicProjection(doc);
  },
});

/**
 * Page over event projections matching an indexed `where` selector.
 * Requires a filter that maps to a projection index (target, target+kind,
 * target+outcome, target+kind+outcome, or one of
 * kind/category/outcome/actor/subject/requestId); throws otherwise. Defaults
 * to `desc` order. Rows are returned in their redacted public shape.
 */
export const list = query({
  args: {
    where: vAuthEventWhere,
    order: v.optional(v.union(v.literal("asc"), v.literal("desc"))),
    paginationOpts: paginationOptsValidator,
  },
  returns: vPaginated(vAuthEventProjectionDoc),
  handler: async (ctx, { where, order, paginationOpts }) => {
    const result = await projectionQuery(ctx.db, where)
      .order(order ?? "desc")
      .paginate(paginationOpts);
    return {
      ...result,
      page: result.page.map(publicProjection),
    };
  },
});

/**
 * Append an auth event, fanning out idempotent projections per target.
 *
 * This is the only write the request path makes: one fresh `AuthEventProjection`
 * row per target — contention-free by construction (distinct docs, unique by the
 * `event_id_target` index), so the auth critical path never touches the durable
 * stream's head. Rows land with sentinel `streamId:""`/`streamIndex:-1`; the
 * `drainPending` cron stamps them once they reach the stream. Returns a command
 * summary (`created` flag plus the affected scopes and projections) so callers
 * can react to the idempotency outcome.
 */
export const append = mutation({
  args: {
    event: vAuthEvent,
    targets: v.optional(v.array(vAuthEventTarget)),
    idempotencyKey: v.optional(v.string()),
  },
  returns: v.object({
    eventId: v.string(),
    created: v.boolean(),
    createdTargets: v.array(vAuthEventTarget),
    projections: v.array(vAuthEventProjectionDoc),
  }),
  handler: async (ctx, args) => {
    const scopes = args.targets ?? args.event.targets;
    if (scopes.length > MAX_EVENT_TARGETS) {
      throw new ConvexError({
        code: ErrorCode.INVALID_PARAMETERS,
        message: `Auth events support at most ${MAX_EVENT_TARGETS} targets`,
      });
    }
    const seenScopes = new Set<string>();
    const createdTargets: AuthEventTarget[] = [];
    const projections: Array<Infer<typeof vAuthEventProjectionDoc>> = [];
    for (const target of scopes) {
      const key = targetKey(target);
      if (seenScopes.has(key)) continue;
      seenScopes.add(key);
      const existing = await ctx.db
        .query("AuthEventProjection")
        .withIndex("event_id_target", (q) =>
          q
            .eq("eventId", args.event.eventId)
            .eq("targetKind", target.kind)
            .eq("targetId", target.id),
        )
        .unique();
      if (existing !== null) {
        projections.push(publicProjection(existing));
        continue;
      }

      const projectionId = await ctx.db.insert("AuthEventProjection", {
        eventId: args.event.eventId,
        targetKind: target.kind,
        targetId: target.id,
        kind: args.event.kind,
        category: args.event.category,
        occurredAt: args.event.occurredAt,
        actorType: args.event.actor.type,
        actorId: args.event.actor.id,
        subjectType: args.event.subject.type,
        subjectId: args.event.subject.id,
        outcome: args.event.outcome,
        errorCode: args.event.errorCode,
        requestId: args.event.request?.requestId,
        ip: args.event.request?.ip,
        userAgent: args.event.request?.userAgent,
        data: args.event.data,
        streamId: "",
        streamIndex: -1,
      });
      const projection = await ctx.db.get("AuthEventProjection", projectionId);
      if (projection !== null) projections.push(publicProjection(projection));
      createdTargets.push(target);
    }
    return {
      eventId: args.event.eventId,
      created: createdTargets.length > 0,
      createdTargets,
      projections,
    };
  },
});

function reconstructEvent(
  eventId: string,
  rows: Doc<"AuthEventProjection">[],
): Infer<typeof vAuthEvent> {
  const [first] = rows;
  return {
    eventId,
    kind: first.kind,
    category: first.category,
    occurredAt: first.occurredAt,
    actor: { type: first.actorType, id: first.actorId },
    subject: { type: first.subjectType, id: first.subjectId },
    targets: rows
      .map((row) => ({ kind: row.targetKind, id: row.targetId }))
      .sort((a, b) => (`${a.kind}:${a.id}` < `${b.kind}:${b.id}` ? -1 : 1)),
    request:
      first.requestId !== undefined || first.ip !== undefined || first.userAgent !== undefined
        ? { requestId: first.requestId, ip: first.ip, userAgent: first.userAgent }
        : undefined,
    outcome: first.outcome,
    errorCode: first.errorCode,
    data: first.data,
  };
}

/**
 * Drain newly-projected auth events into the durable `auth` stream.
 *
 * The single writer to the stream head, triggered by a cron (never the request
 * path), so the durable log is fed without any auth-critical-path contention.
 * Processes the oldest pending events (`streamIndex === -1`) one whole event at
 * a time — reconstructs the envelope from that event's projection rows, appends
 * it under `eventId` as the stream idempotency key, and stamps `streamId`/
 * `streamIndex` onto those rows in the same transaction. Bounded to
 * `DRAIN_BATCH` events per run and self-reschedules while a backlog remains.
 * Idempotent: appendTail + the row stamp commit together, so a re-run only sees
 * still-pending rows and an interrupted append re-appends the same event freshly.
 */
export const drainPending = internalMutation({
  args: {},
  returns: v.null(),
  handler: async (ctx) => {
    const streamId = await authEventStream.getOrCreate(ctx, { key: "auth" });
    let drained = 0;
    while (drained < DRAIN_BATCH) {
      const next = await ctx.db
        .query("AuthEventProjection")
        .withIndex("by_stream_index", (q) => q.eq("streamIndex", -1))
        .order("asc")
        .first();
      if (next === null) return null;

      const rows = await ctx.db
        .query("AuthEventProjection")
        .withIndex("event_id_target", (q) => q.eq("eventId", next.eventId))
        .take(MAX_EVENT_TARGETS + 1);
      if (rows.length > MAX_EVENT_TARGETS) {
        throw new ConvexError({
          code: ErrorCode.INVALID_PARAMETERS,
          message: `Auth event ${next.eventId} has too many projections to drain`,
        });
      }
      const event = reconstructEvent(next.eventId, rows);
      const receipt = await authEventStream.appendTail(ctx, {
        streamId,
        producer: PRODUCER,
        idempotencyKey: next.eventId,
        payloadHash: next.eventId,
        events: [{ event }],
      });
      for (const row of rows) {
        if (row.streamIndex < 0) {
          await ctx.db.patch("AuthEventProjection", row._id, {
            streamId,
            streamIndex: receipt.lastIndex,
          });
        }
      }
      drained += 1;
    }
    await ctx.scheduler.runAfter(0, internal.event.drainPending, {});
    return null;
  },
});
