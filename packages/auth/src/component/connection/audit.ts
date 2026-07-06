/**
 * `component.connection.audit.*` - Connection audit projections backed by auth events.
 *
 * @module
 */

import { paginationOptsValidator } from "convex/server";
import { paginator } from "convex-helpers/server/pagination";
import { ConvexError, v, type Infer } from "convex/values";

import { ErrorCode } from "../../shared/codes";
import type { Doc } from "../_generated/dataModel";
import { query } from "../functions";
import { vAuthEventData, vAuthEventProjectionDoc, vPaginated } from "../model";
import schema from "../schema";

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
  oauth: ["clientId", "codeId", "scopes", "grantType", "resource"],
  connection: [
    "connectionId",
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

function publicData(kind: string, value: unknown): Infer<typeof vAuthEventData> | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined;
  const category = kind.startsWith("api_key.")
    ? "api_key"
    : (kind.slice(0, kind.indexOf(".")) as keyof typeof PUBLIC_DATA_KEYS);
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

function publicProjection(doc: Doc<"AuthEventProjection">) {
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

/**
 * List audit-event projections for a connection or a group, newest first and
 * paginated. Rows are redacted to public fields (IP dropped, `data` narrowed to
 * an allowlist). Requires exactly one of `connectionId` or `groupId` — passing
 * neither throws rather than scanning the entire audit log.
 */
export const list = query({
  args: {
    connectionId: v.optional(v.id("GroupConnection")),
    groupId: v.optional(v.id("Group")),
    paginationOpts: paginationOptsValidator,
  },
  returns: vPaginated(vAuthEventProjectionDoc),
  handler: async (ctx, args) => {
    if (args.connectionId !== undefined) {
      const result = await paginator(ctx.db, schema)
        .query("AuthEventProjection")
        .withIndex("target_time", (idx) =>
          idx.eq("targetKind", "connection").eq("targetId", args.connectionId!),
        )
        .order("desc")
        .paginate(args.paginationOpts);
      return { ...result, page: result.page.map(publicProjection) };
    }
    if (args.groupId !== undefined) {
      const result = await paginator(ctx.db, schema)
        .query("AuthEventProjection")
        .withIndex("target_time", (idx) =>
          idx.eq("targetKind", "group").eq("targetId", args.groupId!),
        )
        .order("desc")
        .paginate(args.paginationOpts);
      return { ...result, page: result.page.map(publicProjection) };
    }
    throw new ConvexError({
      code: ErrorCode.INVALID_PARAMETERS,
      message:
        "connection.audit.list requires either `connectionId` or `groupId` to target the query. Passing neither would walk the entire audit log.",
    });
  },
});
