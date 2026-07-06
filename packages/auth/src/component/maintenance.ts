/**
 * `component.maintenance.*` — scheduled cleanup utilities.
 *
 * Wire `pruneExpired` to a daily cron in the consumer app to keep tables
 * with expiring rows (sessions, refresh tokens, verification codes, PKCE
 * verifiers, invites, device codes) bounded.
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

/**
 * Delete expired rows across the auth tables (sessions, refresh tokens,
 * verification codes, PKCE verifiers, group invites, device codes, OAuth
 * refresh tokens/grants, SAML pending login requests and seen-assertion replay
 * cache) plus terminal webhook deliveries older than the retention window,
 * using each table's expiration/`signedAt` index and range-scanning up to
 * `batchSize` rows per table. Rows with no expiry set (never-expire
 * verifiers/invites) are skipped by the index lower bound, so they cannot stall
 * the scan. When any table fills its batch a backlog remains, so the mutation
 * reschedules itself to drain the rest; the daily cron is the steady-state
 * kick. Returns per-table deletion counts.
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
    oauthRefreshTokens: v.number(),
    oauthRefreshGrants: v.number(),
    webhookDeliveries: v.number(),
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
    let oauthRefreshTokens = 0;
    let oauthRefreshGrants = 0;
    let webhookDeliveries = 0;
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

    const inviteDocs = await ctx.db
      .query("GroupInvite")
      .withIndex("expires_time", (q) => q.gte("expiresTime", 0).lt("expiresTime", now))
      .take(batchSize);
    for (const doc of inviteDocs) {
      if (doc.status !== "expired" && doc.status !== "revoked") {
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

    if (
      sessions === batchSize ||
      refreshTokens === batchSize ||
      verificationCodes === batchSize ||
      authVerifiers === batchSize ||
      invites === batchSize ||
      deviceCodes === batchSize ||
      oauthRefreshTokens === batchSize ||
      oauthRefreshGrants === batchSize ||
      webhookDeliveries === batchSize ||
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
      oauthRefreshTokens,
      oauthRefreshGrants,
      webhookDeliveries,
      samlLoginRequests,
      samlSeenAssertions,
    };
  },
});
