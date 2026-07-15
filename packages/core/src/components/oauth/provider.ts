import { v } from "convex/values";
import { env, internalMutation, mutation } from "./_generated/server";

/** How long an authorization request stays claimable by the callback. */
const AUTHORIZATION_REQUEST_TTL_MS = 10 * 60 * 1000;

/** How long a minted ticket stays redeemable. Redemption is normally the
 * page load right after the callback redirect, so this only needs slack
 * for slow devices and networks. */
const TICKET_TTL_MS = 2 * 60 * 1000;

/**
 * Record an in-flight authorization request. Called by the app-side
 * `signIn` before it redirects the user to the provider; the provider
 * callback later claims the request by state hash.
 *
 * Exchange config the callback needs (`tokenEndpoint`, `userinfoEndpoints`)
 * is snapshotted onto the row here because the component can't see app-side
 * config.
 *
 * Returns the two per-mount values the caller needs to build the
 * authorization URL: the component's mounted base URL
 * (`process.env.CONVEX_SITE_URL` is overridden inside components to include
 * the `httpPrefix` the app mounted the component under) and the mount's
 * `CLIENT_ID` env binding.
 */
export const createAuthorizationRequest = mutation({
  args: {
    provider: v.string(),
    stateHash: v.string(),
    redirectTo: v.string(),
    codeVerifier: v.optional(v.string()),
    tokenEndpoint: v.string(),
    userinfoEndpoints: v.optional(v.record(v.string(), v.string())),
  },
  returns: v.object({
    callbackBaseUrl: v.string(),
    clientId: v.string(),
  }),
  handler: async (ctx, args) => {
    const siteUrl = process.env.CONVEX_SITE_URL;
    if (siteUrl === undefined) {
      throw new Error("CONVEX_SITE_URL is not set");
    }
    await ctx.db.insert("authorizationRequests", {
      ...args,
      expiresAt: Date.now() + AUTHORIZATION_REQUEST_TTL_MS,
    });
    return { callbackBaseUrl: siteUrl, clientId: env.CLIENT_ID };
  },
});

/**
 * Claim an authorization request by state hash: find, delete, and return it
 * in one transaction, so a replayed or raced callback finds nothing. An
 * expired row is also deleted but not returned.
 */
export const claimAuthorizationRequest = internalMutation({
  args: {
    stateHash: v.string(),
  },
  returns: v.union(
    v.null(),
    v.object({
      provider: v.string(),
      stateHash: v.string(),
      redirectTo: v.string(),
      codeVerifier: v.optional(v.string()),
      tokenEndpoint: v.string(),
      userinfoEndpoints: v.optional(v.record(v.string(), v.string())),
    }),
  ),
  handler: async (ctx, args) => {
    const request = await ctx.db
      .query("authorizationRequests")
      .withIndex("stateHash", (q) => q.eq("stateHash", args.stateHash))
      .unique();
    if (request === null) {
      return null;
    }
    await ctx.db.delete(request._id);
    if (request.expiresAt < Date.now()) {
      return null;
    }
    return {
      provider: request.provider,
      stateHash: request.stateHash,
      redirectTo: request.redirectTo,
      codeVerifier: request.codeVerifier,
      tokenEndpoint: request.tokenEndpoint,
      userinfoEndpoints: request.userinfoEndpoints,
    };
  },
});

/**
 * Mint a one-time redeemable ticket after a successful code exchange. The
 * caller (the callback) holds the raw one-time token; only its hash is
 * stored.
 */
export const createTicket = internalMutation({
  args: {
    provider: v.string(),
    stateHash: v.string(),
    ottHash: v.string(),
    claims: v.optional(v.any()),
    userInfoResponses: v.optional(v.record(v.string(), v.any())),
  },
  returns: v.null(),
  handler: async (ctx, args) => {
    await ctx.db.insert("tickets", {
      ...args,
      expiresAt: Date.now() + TICKET_TTL_MS,
    });
    return null;
  },
});

/**
 * Claim a ticket by one-time token hash: find, check, delete, and return it
 * in one transaction, so a replayed or raced redemption finds nothing.
 *
 * The caller must also present the hash of the state minted at sign-in,
 * binding redemption to the client that initiated the flow. A state mismatch
 * returns null *without* deleting: someone holding a stolen one-time token
 * but not the state must not be able to burn the real client's ticket. An
 * expired row is deleted but not returned. All failures are indistinguishable
 * to the caller.
 */
export const claimTicket = mutation({
  args: {
    ottHash: v.string(),
    stateHash: v.string(),
  },
  returns: v.union(
    v.null(),
    v.object({
      provider: v.string(),
      claims: v.optional(v.any()),
      userInfoResponses: v.optional(v.record(v.string(), v.any())),
    }),
  ),
  handler: async (ctx, args) => {
    const ticket = await ctx.db
      .query("tickets")
      .withIndex("ottHash", (q) => q.eq("ottHash", args.ottHash))
      .unique();
    if (ticket === null) {
      return null;
    }
    if (ticket.expiresAt < Date.now()) {
      await ctx.db.delete(ticket._id);
      return null;
    }
    if (ticket.stateHash !== args.stateHash) {
      return null;
    }
    await ctx.db.delete(ticket._id);
    return {
      provider: ticket.provider,
      claims: ticket.claims,
      userInfoResponses: ticket.userInfoResponses,
    };
  },
});
