/**
 * Component-internal data migrations, run via the `@convex-dev/migrations`
 * component mounted in `convex.config.ts`.
 *
 * The auth component owns its own tables, so migrations over them must run
 * *inside* the component. These are registered (exported) so they are runnable
 * from the CLI/dashboard; they are intentionally NOT wired to a cron — data
 * migrations here can rename/clear/drop rows and must be triggered explicitly
 * after an upgrade, never on an automatic schedule.
 *
 * ## 0.1 upgrade sequence (run once, in order, after `convex deploy`)
 *
 * The 0.1 schema is deliberately PERMISSIVE (deprecated fields retained as
 * optional, tightened validators relaxed) so it deploys over pre-existing
 * preview data. These migrations move that data onto the new fields; a later
 * major release re-tightens the schema once every row conforms.
 *
 * ```sh
 * # Core: strip the denormalized User.hasTotp cache.
 * npx convex run auth/migrations:runDropHasTotp '{}'
 * # OAuth: backfill tokenEndpointAuthMethod from the legacy secret-hash inference.
 * npx convex run auth/migrations:runBackfillOAuthClientAuthMethod '{}'
 * # Events/webhooks: rename connection/SCIM kinds AND backfill legacy webhook
 * # delivery rows (eventType/auditEventId -> kind/eventId).
 * npx convex run auth/migrations:runRenameConnectionEventKinds '{}'
 * # API keys: copy the renamed metadata blob into extend.
 * npx convex run auth/migrations:runBackfillApiKeyExtend '{}'
 * # Groups: clear the removed faceted-tags field.
 * npx convex run auth/migrations:runDropGroupTags '{}'
 * ```
 *
 * Two backfills CANNOT run from here and must run SERVER-SIDE (they need the
 * `AUTH_SECRET_ENCRYPTION_KEY` / crypto only available outside a component
 * mutation): re-encrypting `GroupWebhookEndpoint.secretHash` into
 * `secretCiphertext`, and any secret re-keying. Until they run, pre-existing
 * webhook-endpoint rows deploy fine but fail the strict read validator in
 * `model.ts`. See `schema.ts` for the per-field deprecation notes.
 *
 * @module
 */

import { Migrations } from "@convex-dev/migrations";

import { components, internal } from "./_generated/api";
import type { DataModel } from "./_generated/dataModel";
import { internalMutation } from "./_generated/server";
import { EVENT_KINDS, type AuthEventKind } from "../shared/event/kinds";

/** Migrations registry over the component's own `DataModel`. */
export const migrations = new Migrations<DataModel>(components.migrations, {
  internalMutation,
});

/**
 * Strip the deprecated denormalized `User.hasTotp` cache from every row.
 *
 * The field was removed from the typed surface; this clears it from
 * pre-existing data so it can eventually be dropped from the schema.
 * Idempotent — rows without the field are skipped.
 */
export const dropHasTotp = migrations.define({
  table: "User",
  migrateOne: (_ctx, doc) =>
    (doc as { hasTotp?: boolean }).hasTotp === undefined ? undefined : { hasTotp: undefined },
});

/** CLI/dashboard runner: `npx convex run auth/migrations:runDropHasTotp`. */
export const runDropHasTotp = migrations.runner(internal.migrations.dropHasTotp);

/**
 * Backfill `OAuthClient.tokenEndpointAuthMethod` on pre-existing rows so the
 * token endpoint can drive client authentication from the stored method rather
 * than the legacy "a secret hash exists" inference. A row with a secret becomes
 * `client_secret_post` (the historical DCR default); one without becomes `none`
 * (it was only ever authenticatable by PKCE). Idempotent — rows already
 * carrying a method are skipped.
 */
export const backfillOAuthClientAuthMethod = migrations.define({
  table: "OAuthClient",
  migrateOne: (_ctx, doc) =>
    doc.tokenEndpointAuthMethod !== undefined
      ? undefined
      : {
          tokenEndpointAuthMethod: doc.clientSecretHash
            ? ("client_secret_post" as const)
            : ("none" as const),
        },
});

/** CLI/dashboard runner: `npx convex run auth/migrations:runBackfillOAuthClientAuthMethod`. */
export const runBackfillOAuthClientAuthMethod = migrations.runner(
  internal.migrations.backfillOAuthClientAuthMethod,
);

/**
 * Backfill renamed connection/SCIM auth-event kinds on persisted rows.
 *
 * Two breaking renames landed on the event vocabulary:
 * - protocol-config events `connection.{saml,oidc}.configured` /
 *   `scim.configured` → `.set` (mirroring the `auth.connection.*.set` facade);
 * - SCIM events `scim.*` gained the `connection.` namespace prefix
 *   (`scim.user.provisioned` → `connection.scim.user.provisioned`).
 *
 * Stored `kind` lives on three tables: the `AuthEventProjection` log, the
 * `GroupWebhookEndpoint.subscriptions` array, and `GroupWebhookDelivery` rows.
 * The `category` column is unchanged — SCIM events keep `category: "scim"`.
 * Idempotent: rows already on a new kind are not in the map and are skipped.
 */
const CONNECTION_EVENT_KIND_RENAMES: Record<string, string> = {
  "connection.saml.configured": "connection.saml.set",
  "connection.oidc.configured": "connection.oidc.set",
  "scim.configured": "connection.scim.set",
  "scim.read": "connection.scim.read",
  "scim.user.provisioned": "connection.scim.user.provisioned",
  "scim.user.updated": "connection.scim.user.updated",
  "scim.user.deactivated": "connection.scim.user.deactivated",
  "scim.user.reactivated": "connection.scim.user.reactivated",
  "scim.group.provisioned": "connection.scim.group.provisioned",
  "scim.group.updated": "connection.scim.group.updated",
  "scim.group.deactivated": "connection.scim.group.deactivated",
  "scim.group.reactivated": "connection.scim.group.reactivated",
};

/**
 * Resolve a legacy webhook-delivery `eventType` string to a current, valid
 * {@link AuthEventKind}. Applies the connection/SCIM rename map first, then
 * verifies the result is a live kind. Returns `null` when it cannot be mapped
 * onto the current taxonomy (the caller then drops the un-deliverable row).
 */
function resolveDeliveryKind(eventType: string | undefined): AuthEventKind | null {
  if (eventType === undefined) return null;
  const candidate = CONNECTION_EVENT_KIND_RENAMES[eventType] ?? eventType;
  return Object.prototype.hasOwnProperty.call(EVENT_KINDS, candidate)
    ? (candidate as AuthEventKind)
    : null;
}

/** Rewrite renamed connection/SCIM `kind` values on `AuthEventProjection` rows. */
export const renameAuthEventProjectionKinds = migrations.define({
  table: "AuthEventProjection",
  migrateOne: (_ctx, doc) => {
    const next = CONNECTION_EVENT_KIND_RENAMES[doc.kind as string];
    return next === undefined ? undefined : { kind: next as typeof doc.kind };
  },
});

/** Rewrite renamed event kinds inside each `GroupWebhookEndpoint.subscriptions` array. */
export const renameWebhookEndpointSubscriptions = migrations.define({
  table: "GroupWebhookEndpoint",
  migrateOne: (_ctx, doc) => {
    const subscriptions = doc.subscriptions as string[];
    let changed = false;
    const next = subscriptions.map((kind) => {
      const renamed = CONNECTION_EVENT_KIND_RENAMES[kind];
      if (renamed !== undefined) changed = true;
      return renamed ?? kind;
    });
    return changed ? { subscriptions: next as typeof doc.subscriptions } : undefined;
  },
});

/**
 * Backfill and rename `GroupWebhookDelivery` event fields.
 *
 * Two populations of rows are handled:
 *
 * 1. **Legacy preview rows** (`kind` absent) carry the removed
 *    `eventType`/`auditEventId` fields (the old audit taxonomy). Reconstruct the
 *    new fields: `kind` from `eventType` (via {@link resolveDeliveryKind}),
 *    `eventId` from `auditEventId`. Synthesize `signedAt` (from `_creationTime`)
 *    and `signature` (empty) when the row predates the signing scheme, and
 *    settle any still-open row as `failed` — a legacy delivery cannot be safely
 *    re-signed and re-sent, and leaving `kind`/`signedAt` unset would fail the
 *    strict read validator in `model.ts`. A row whose `eventType` cannot be
 *    mapped is un-addressable and un-deliverable, so it is DELETED.
 * 2. **Current rows** (`kind` present) may hold a connection/SCIM `kind` that
 *    was later renamed; apply the rename map.
 *
 * Idempotent: current rows already on a live kind are skipped; legacy rows lose
 * `eventType`/`auditEventId` after the first pass so they take branch 2 next
 * time.
 *
 * NOTE: the earlier version read the NEW `kind` field, so it never touched the
 * legacy rows (whose `kind` was absent) — it was a silent no-op for the upgrade.
 */
export const renameWebhookDeliveryKinds = migrations.define({
  table: "GroupWebhookDelivery",
  migrateOne: async (ctx, doc) => {
    if (doc.kind === undefined) {
      const kind = resolveDeliveryKind(doc.eventType);
      const eventId = doc.eventId ?? doc.auditEventId;
      if (kind === null || eventId === undefined) {
        await ctx.db.delete("GroupWebhookDelivery", doc._id);
        return undefined;
      }
      return {
        kind,
        eventId,
        status:
          doc.status === "pending" || doc.status === "processing"
            ? ("failed" as const)
            : doc.status,
        signature: doc.signature ?? "",
        signedAt: doc.signedAt ?? doc._creationTime,
        eventType: undefined,
        auditEventId: undefined,
      };
    }
    const next = CONNECTION_EVENT_KIND_RENAMES[doc.kind];
    return next === undefined ? undefined : { kind: next as typeof doc.kind };
  },
});

/**
 * CLI/dashboard runner — runs the event-kind rename + webhook backfill as a
 * series: `npx convex run auth/migrations:runRenameConnectionEventKinds`.
 *
 * Renames connection/SCIM kinds on projections, webhook-endpoint subscriptions,
 * and webhook deliveries, and (in the delivery pass) backfills the legacy
 * `eventType`/`auditEventId` fields onto `kind`/`eventId`. NOTE: the delivery
 * pass DROPS legacy delivery rows whose `eventType` cannot be mapped onto the
 * current taxonomy (they are un-addressable and un-deliverable).
 */
export const runRenameConnectionEventKinds = migrations.runner([
  internal.migrations.renameAuthEventProjectionKinds,
  internal.migrations.renameWebhookEndpointSubscriptions,
  internal.migrations.renameWebhookDeliveryKinds,
]);

/**
 * Copy the renamed `ApiKey.metadata` blob into `extend` (the app-extension
 * field), then clear `metadata`. When both are present `extend` wins and
 * `metadata` is discarded — the rename made them the same field, so the new
 * name is authoritative. Idempotent: rows without `metadata` are skipped.
 */
export const backfillApiKeyExtend = migrations.define({
  table: "ApiKey",
  migrateOne: (_ctx, doc) => {
    if (doc.metadata === undefined) return undefined;
    return {
      ...(doc.extend === undefined ? { extend: doc.metadata } : {}),
      metadata: undefined,
    };
  },
});

/** CLI/dashboard runner: `npx convex run auth/migrations:runBackfillApiKeyExtend`. */
export const runBackfillApiKeyExtend = migrations.runner(internal.migrations.backfillApiKeyExtend);

/**
 * Clear the removed `Group.tags` field from pre-existing rows so it can
 * eventually be dropped from the schema. Idempotent — rows without the field
 * are skipped.
 */
export const dropGroupTags = migrations.define({
  table: "Group",
  migrateOne: (_ctx, doc) => (doc.tags === undefined ? undefined : { tags: undefined }),
});

/** CLI/dashboard runner: `npx convex run auth/migrations:runDropGroupTags`. */
export const runDropGroupTags = migrations.runner(internal.migrations.dropGroupTags);
