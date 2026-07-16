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
 * Exchange config the callback needs (`callbackUrl`, `tokenEndpoint`,
 * `userInfoEndpoints`) is snapshotted onto the row here because the
 * component can't see app-side config or system env vars — a typed-env
 * component's `process.env` only contains its bound vars, so the caller
 * builds `callbackUrl` from `CONVEX_SITE_URL` app-side.
 *
 * Returns the mount's `CLIENT_ID` env binding, which the caller needs for
 * the authorization URL.
 */
export const createAuthorizationRequest = mutation({
  args: {
    provider: v.string(),
    stateHash: v.string(),
    redirectTo: v.string(),
    callbackUrl: v.string(),
    codeVerifier: v.optional(v.string()),
    tokenEndpoint: v.string(),
    userInfoEndpoints: v.optional(v.record(v.string(), v.string())),
    issuer: v.optional(v.string()),
  },
  returns: v.object({
    clientId: v.string(),
  }),
  handler: async (ctx, args) => {
    // The env declaration guarantees the bindings exist at deploy time but
    // can't express non-emptiness; catch that here, at the first sign-in,
    // rather than on the provider's error page.
    if (env.CLIENT_ID === "" || env.CLIENT_SECRET === "") {
      throw new Error(
        "The CLIENT_ID and CLIENT_SECRET env bindings must not be empty",
      );
    }
    await ctx.db.insert("authorizationRequests", {
      ...args,
      expiresAt: Date.now() + AUTHORIZATION_REQUEST_TTL_MS,
    });
    return { clientId: env.CLIENT_ID };
  },
});

/**
 * Claim an authorization request by state hash: find, delete, and return it
 * in one transaction, so a replayed or raced callback finds nothing. An
 * expired row is also deleted, but only its `redirectTo` is returned so the
 * callback can send the user back to the app instead of stranding them on
 * an error page.
 */
export const claimAuthorizationRequest = internalMutation({
  args: {
    stateHash: v.string(),
  },
  returns: v.union(
    v.null(),
    v.object({
      expired: v.literal(true),
      redirectTo: v.string(),
    }),
    v.object({
      expired: v.literal(false),
      provider: v.string(),
      stateHash: v.string(),
      redirectTo: v.string(),
      callbackUrl: v.string(),
      codeVerifier: v.optional(v.string()),
      tokenEndpoint: v.string(),
      userInfoEndpoints: v.optional(v.record(v.string(), v.string())),
      issuer: v.optional(v.string()),
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
    await ctx.db.delete("authorizationRequests", request._id);
    if (request.expiresAt < Date.now()) {
      return { expired: true as const, redirectTo: request.redirectTo };
    }
    return {
      expired: false as const,
      provider: request.provider,
      stateHash: request.stateHash,
      redirectTo: request.redirectTo,
      callbackUrl: request.callbackUrl,
      codeVerifier: request.codeVerifier,
      tokenEndpoint: request.tokenEndpoint,
      userInfoEndpoints: request.userInfoEndpoints,
      issuer: request.issuer,
    };
  },
});

/**
 * Mint a one-time redeemable ticket after a successful code exchange. The
 * caller (the callback) holds the raw one-time token; only its hash is
 * stored, and the identity payload arrives already encrypted with a key
 * derived from that token.
 */
export const createTicket = internalMutation({
  args: {
    provider: v.string(),
    stateHash: v.string(),
    ottHash: v.string(),
    payload: v.string(),
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
 * binding redemption to the client that initiated the flow, and the provider
 * name it expects, so a misconfigured or renamed provider instance can't
 * redeem a ticket into the wrong account namespace. A state or provider
 * mismatch returns null *without* deleting: someone holding a stolen
 * one-time token but not the state must not be able to burn the real
 * client's ticket. An expired row is deleted but not returned. All failures
 * are indistinguishable to the caller.
 */
export const claimTicket = mutation({
  args: {
    provider: v.string(),
    ottHash: v.string(),
    stateHash: v.string(),
  },
  returns: v.union(
    v.null(),
    v.object({
      payload: v.string(),
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
      await ctx.db.delete("tickets", ticket._id);
      return null;
    }
    if (
      ticket.stateHash !== args.stateHash ||
      ticket.provider !== args.provider
    ) {
      return null;
    }
    await ctx.db.delete("tickets", ticket._id);
    return { payload: ticket.payload };
  },
});
