/**
 * `component.maintenance.*` — scheduled cleanup utilities.
 *
 * Wire `pruneExpired` to a daily cron in the consumer app to keep tables
 * with expiring or unbounded-growth rows (sessions, refresh tokens,
 * verification codes, PKCE verifiers, invites, device codes, OAuth codes,
 * connection domain verifications, webhook deliveries, and drained auth-event
 * projections) bounded.
 *
 * @module
 */

import { v } from "convex/values";

import { internal } from "./_generated/api";
import { internalMutation } from "./functions";

const DEFAULT_BATCH_SIZE = 200;
const MAX_BATCH_SIZE = 1000;

/** Terminal webhook deliveries are pruned once they are older than this. */
const WEBHOOK_DELIVERY_RETENTION_MS = 7 * 24 * 60 * 60 * 1000;

/** Drained auth-event projections are pruned once they are older than this. */
const AUTH_EVENT_PROJECTION_RETENTION_MS = 90 * 24 * 60 * 60 * 1000;

/**
 * Terminal (expired/revoked) invites whose `expiresTime` was cleared on
 * transition are reclaimed once their creation age exceeds this window.
 */
const INVITE_TERMINAL_RETENTION_MS = 90 * 24 * 60 * 60 * 1000;

/** Terminal invite statuses reclaimed by age (their `expiresTime` is cleared on transition). */
const TERMINAL_INVITE_STATUSES = ["expired", "revoked"] as const;

/**
 * Delete expired / over-retention rows across the auth tables, using each
 * table's expiration/time index and range-scanning up to `batchSize` rows per
 * table:
 *
 * - Expiry-driven: sessions, refresh tokens, verification codes, PKCE
 *   verifiers, device codes, OAuth codes, OAuth refresh tokens/grants,
 *   connection domain verifications, SAML pending login requests and
 *   seen-assertion replay cache. Rows with no expiry set (never-expire
 *   verifiers) are skipped by the index lower bound, so they cannot stall the
 *   scan.
 * - Retention-window-driven: terminal webhook deliveries (older than
 *   {@link WEBHOOK_DELIVERY_RETENTION_MS}) and DRAINED auth-event projections
 *   (older than {@link AUTH_EVENT_PROJECTION_RETENTION_MS}; undrained rows are
 *   preserved).
 * - Invites: every past-`expiresTime` invite is reclaimed (so the index front
 *   always advances — no terminal-invite starvation), plus terminal invites
 *   whose `expiresTime` was cleared on transition are reclaimed by creation age.
 *
 * When a table fills its batch a backlog remains, so the mutation reschedules
 * itself to drain the rest; the daily cron is the steady-state kick. Returns
 * per-table deletion counts.
 */
export const pruneExpired = internalMutation({
  args: {
    batchSize: v.optional(v.number()),
  },
  returns: v.object({
    sessions: v.number(),
    refreshTokens: v.number(),
    verificationCodes: v.number(),
    authVerifiers: v.number(),
    invites: v.number(),
    deviceCodes: v.number(),
    oauthCodes: v.number(),
    oauthRefreshTokens: v.number(),
    oauthRefreshGrants: v.number(),
    webhookDeliveries: v.number(),
    authEventProjections: v.number(),
    connectionDomainVerifications: v.number(),
    samlLoginRequests: v.number(),
    samlSeenAssertions: v.number(),
  }),
  handler: async (ctx, args) => {
    const batchSize = Math.min(Math.max(args.batchSize ?? DEFAULT_BATCH_SIZE, 1), MAX_BATCH_SIZE);
    const now = Date.now();

    let sessions = 0;
    let refreshTokens = 0;
    let verificationCodes = 0;
    let authVerifiers = 0;
    let invites = 0;
    let deviceCodes = 0;
    let oauthCodes = 0;
    let oauthRefreshTokens = 0;
    let oauthRefreshGrants = 0;
    let webhookDeliveries = 0;
    let authEventProjections = 0;
    let connectionDomainVerifications = 0;
    let samlLoginRequests = 0;
    let samlSeenAssertions = 0;

    const sessionDocs = await ctx.db
      .query("Session")
      .withIndex("expiration_time", (q) => q.lt("expirationTime", now))
      .take(batchSize);
    for (const doc of sessionDocs) {
      await ctx.db.delete("Session", doc._id);
      sessions += 1;
    }

    const refreshDocs = await ctx.db
      .query("RefreshToken")
      .withIndex("expiration_time", (q) => q.lt("expirationTime", now))
      .take(batchSize);
    for (const doc of refreshDocs) {
      await ctx.db.delete("RefreshToken", doc._id);
      refreshTokens += 1;
    }

    const verificationDocs = await ctx.db
      .query("VerificationCode")
      .withIndex("expiration_time", (q) => q.lt("expirationTime", now))
      .take(batchSize);
    for (const doc of verificationDocs) {
      await ctx.db.delete("VerificationCode", doc._id);
      verificationCodes += 1;
    }

    const verifierDocs = await ctx.db
      .query("AuthVerifier")
      .withIndex("expiration_time", (q) => q.gte("expirationTime", 0).lt("expirationTime", now))
      .take(batchSize);
    for (const doc of verifierDocs) {
      await ctx.db.delete("AuthVerifier", doc._id);
      authVerifiers += 1;
    }

    // (A) Reclaim every invite that has passed its `expiresTime`. This deletes
    // pending invites that expired AND any terminal (expired/revoked) invite that
    // still carries a past `expiresTime` — legacy rows written before terminal
    // transitions cleared it (see group/invite.ts). The previous version deleted
    // only NON-terminal rows, so terminal rows kept their past `expiresTime` and
    // pinned the front of the `expires_time` index forever; with the reschedule
    // keyed on the DELETED count it then stopped advancing (starvation). Now every
    // scanned row is deleted so the front always advances, and we reschedule on the
    // SCANNED count.
    const inviteDocs = await ctx.db
      .query("GroupInvite")
      .withIndex("expires_time", (q) => q.gte("expiresTime", 0).lt("expiresTime", now))
      .take(batchSize);
    const invitesScanned = inviteDocs.length;
    for (const doc of inviteDocs) {
      await ctx.db.delete("GroupInvite", doc._id);
      invites += 1;
    }

    // (B) Reclaim terminal invites whose `expiresTime` was cleared on transition
    // (so they no longer appear in the `expires_time` index above) once they are
    // older than the retention window. Bounded by creation age via the `status`
    // index (whose implicit trailing sort key is `_creationTime`): oldest first,
    // stop at the first row still inside the window. Without this, clearing
    // `expiresTime` on terminal transitions would leak terminal invites forever.
    const inviteTerminalCutoff = now - INVITE_TERMINAL_RETENTION_MS;
    for (const status of TERMINAL_INVITE_STATUSES) {
      if (invites >= batchSize) break;
      const terminalDocs = await ctx.db
        .query("GroupInvite")
        .withIndex("status", (q) => q.eq("status", status))
        .order("asc")
        .take(batchSize - invites);
      for (const doc of terminalDocs) {
        if (doc._creationTime >= inviteTerminalCutoff) break;
        await ctx.db.delete("GroupInvite", doc._id);
        invites += 1;
      }
    }

    const deviceDocs = await ctx.db
      .query("DeviceCode")
      .withIndex("expires_at", (q) => q.lt("expiresAt", now))
      .take(batchSize);
    for (const doc of deviceDocs) {
      await ctx.db.delete("DeviceCode", doc._id);
      deviceCodes += 1;
    }

    const oauthRefreshTokenDocs = await ctx.db
      .query("OAuthRefreshToken")
      .withIndex("expires_at", (q) => q.lt("expiresAt", now))
      .take(batchSize);
    for (const doc of oauthRefreshTokenDocs) {
      await ctx.db.delete("OAuthRefreshToken", doc._id);
      oauthRefreshTokens += 1;
    }

    const oauthRefreshGrantDocs = await ctx.db
      .query("OAuthRefreshGrant")
      .withIndex("expires_at", (q) => q.lt("expiresAt", now))
      .take(batchSize);
    for (const doc of oauthRefreshGrantDocs) {
      await ctx.db.delete("OAuthRefreshGrant", doc._id);
      oauthRefreshGrants += 1;
    }

    // Single-use OAuth authorization codes are dead once expired (the token
    // endpoint rejects an expired or already-used code), so past-expiry rows —
    // used or not — are safe to reclaim.
    const oauthCodeDocs = await ctx.db
      .query("OAuthCode")
      .withIndex("expires_at", (q) => q.lt("expiresAt", now))
      .take(batchSize);
    for (const doc of oauthCodeDocs) {
      await ctx.db.delete("OAuthCode", doc._id);
      oauthCodes += 1;
    }

    // Expired DNS TXT verification challenges can no longer be completed.
    const domainVerificationDocs = await ctx.db
      .query("GroupConnectionDomainVerification")
      .withIndex("expires_at", (q) => q.lt("expiresAt", now))
      .take(batchSize);
    for (const doc of domainVerificationDocs) {
      await ctx.db.delete("GroupConnectionDomainVerification", doc._id);
      connectionDomainVerifications += 1;
    }

    const webhookCutoff = now - WEBHOOK_DELIVERY_RETENTION_MS;
    for (const status of ["delivered", "failed"] as const) {
      if (webhookDeliveries >= batchSize) break;
      const deliveryDocs = await ctx.db
        .query("GroupWebhookDelivery")
        .withIndex("status_signed_at", (q) => q.eq("status", status).lt("signedAt", webhookCutoff))
        .take(batchSize - webhookDeliveries);
      for (const doc of deliveryDocs) {
        await ctx.db.delete("GroupWebhookDelivery", doc._id);
        webhookDeliveries += 1;
      }
    }

    const samlRequestDocs = await ctx.db
      .query("SamlLoginRequest")
      .withIndex("expires_at", (q) => q.lt("expiresAt", now))
      .take(batchSize);
    for (const doc of samlRequestDocs) {
      await ctx.db.delete("SamlLoginRequest", doc._id);
      samlLoginRequests += 1;
    }

    const samlSeenDocs = await ctx.db
      .query("SamlSeenAssertion")
      .withIndex("expires_at", (q) => q.lt("expiresAt", now))
      .take(batchSize);
    for (const doc of samlSeenDocs) {
      await ctx.db.delete("SamlSeenAssertion", doc._id);
      samlSeenAssertions += 1;
    }

    // Retention for the queryable auth-event log. Only DRAINED rows
    // (`streamIndex >= 0`, already durable in the stream) are deleted; undrained
    // rows (`streamIndex === -1`) are skipped so a stuck drainer never loses
    // events. The `occurred_at` index orders by event time; undrained rows are
    // rare and pruned drained rows correlate with the oldest occurredAt, so the
    // scan front advances. We reschedule only when a full batch was scanned AND
    // something was deleted, so a front made entirely of (rare) old undrained
    // rows cannot spin the self-reschedule.
    const authEventCutoff = now - AUTH_EVENT_PROJECTION_RETENTION_MS;
    const authEventDocs = await ctx.db
      .query("AuthEventProjection")
      .withIndex("occurred_at", (q) => q.lt("occurredAt", authEventCutoff))
      .take(batchSize);
    const authEventsScanned = authEventDocs.length;
    for (const doc of authEventDocs) {
      if (doc.streamIndex >= 0) {
        await ctx.db.delete("AuthEventProjection", doc._id);
        authEventProjections += 1;
      }
    }

    if (
      sessions === batchSize ||
      refreshTokens === batchSize ||
      verificationCodes === batchSize ||
      authVerifiers === batchSize ||
      invitesScanned === batchSize ||
      invites >= batchSize ||
      deviceCodes === batchSize ||
      oauthCodes === batchSize ||
      oauthRefreshTokens === batchSize ||
      oauthRefreshGrants === batchSize ||
      webhookDeliveries === batchSize ||
      connectionDomainVerifications === batchSize ||
      (authEventsScanned === batchSize && authEventProjections > 0) ||
      samlLoginRequests === batchSize ||
      samlSeenAssertions === batchSize
    ) {
      await ctx.scheduler.runAfter(0, internal.maintenance.pruneExpired, { batchSize });
    }

    return {
      sessions,
      refreshTokens,
      verificationCodes,
      authVerifiers,
      invites,
      deviceCodes,
      oauthCodes,
      oauthRefreshTokens,
      oauthRefreshGrants,
      webhookDeliveries,
      authEventProjections,
      connectionDomainVerifications,
      samlLoginRequests,
      samlSeenAssertions,
    };
  },
});
