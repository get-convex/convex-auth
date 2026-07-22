/**
 * `component.oauth.code.*` — OAuth 2.1 authorization codes.
 *
 * Codes are short-lived (2 min) and single-use. `accept` enforces both.
 *
 * @module
 */

import { ConvexError, v } from "convex/values";
import { ErrorCode } from "../../shared/codes";

import { mutation, query } from "../functions";
import { vOAuthCodeDoc } from "../model";

/** Read an authorization code by its hash. */
export const get = query({
  args: { codeHash: v.string() },
  returns: v.union(vOAuthCodeDoc, v.null()),
  handler: async (ctx, { codeHash }) => {
    return await ctx.db
      .query("OAuthCode")
      .withIndex("code_hash", (q) => q.eq("codeHash", codeHash))
      .first();
  },
});

/** Issue a single-use authorization code bound to a user, client, and PKCE challenge. */
export const create = mutation({
  args: {
    codeHash: v.string(),
    userId: v.id("User"),
    clientId: v.string(),
    redirectUri: v.string(),
    scopes: v.array(v.string()),
    codeChallenge: v.string(),
    resource: v.optional(v.string()),
    expiresAt: v.number(),
  },
  returns: v.id("OAuthCode"),
  handler: async (ctx, args) => {
    return await ctx.db.insert("OAuthCode", args);
  },
});

/**
 * Atomically validate the code binding (client, `redirectUri`, PKCE
 * `codeChallenge`), mark the code as used, and return it. Returns `null` —
 * WITHOUT burning the code — if the hash is not found or any binding fails, so a
 * wrong `redirect_uri`/`code_verifier` attempt cannot consume a legitimate code.
 * Throws `OAUTH_CODE_ALREADY_USED` on replay and `OAUTH_CODE_EXPIRED` if stale.
 */
export const accept = mutation({
  args: {
    codeHash: v.string(),
    clientId: v.string(),
    redirectUri: v.string(),
    codeChallenge: v.string(),
    // When present, mint the refresh grant + token in the SAME transaction that
    // consumes the code. The token exchange runs in an action, so accepting the
    // code (one mutation) and creating the refresh (another) were two separate
    // transactions: if the second failed, the code was already burned and the
    // client could not obtain a refresh token without a full re-authorization.
    // Folding the insert here makes the code-consumption and refresh-creation
    // atomic — a failure rolls back BOTH, leaving the code unused for retry. The
    // secret is generated in the action (mutations have no CSPRNG); only its
    // `tokenHash` crosses the boundary.
    refresh: v.optional(
      v.object({
        tokenHash: v.string(),
        expiresAt: v.number(),
      }),
    ),
  },
  returns: v.union(vOAuthCodeDoc, v.null()),
  handler: async (ctx, { codeHash, clientId, redirectUri, codeChallenge, refresh }) => {
    const doc = await ctx.db
      .query("OAuthCode")
      .withIndex("code_hash", (q) => q.eq("codeHash", codeHash))
      .first();
    if (doc === null) return null;
    if (doc.clientId !== clientId) return null;
    if (doc.redirectUri !== redirectUri) return null;
    if (doc.codeChallenge !== codeChallenge) return null;
    if (doc.usedAt !== undefined) {
      throw new ConvexError({ code: ErrorCode.OAUTH_CODE_ALREADY_USED, codeHash });
    }
    if (doc.expiresAt < Date.now()) {
      throw new ConvexError({ code: ErrorCode.OAUTH_CODE_EXPIRED, codeHash });
    }
    const usedAt = Date.now();
    await ctx.db.patch("OAuthCode", doc._id, { usedAt });
    if (refresh !== undefined) {
      const grantId = await ctx.db.insert("OAuthRefreshGrant", {
        clientId: doc.clientId,
        userId: doc.userId,
        scopes: doc.scopes,
        resource: doc.resource,
        expiresAt: refresh.expiresAt,
      });
      await ctx.db.insert("OAuthRefreshToken", {
        tokenHash: refresh.tokenHash,
        grantId,
        expiresAt: refresh.expiresAt,
      });
    }
    return { ...doc, usedAt };
  },
});
