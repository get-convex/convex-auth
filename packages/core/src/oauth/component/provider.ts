import { v } from "convex/values";
import { internalMutation, mutation } from "./_generated/server";
import { getCredentials } from "./credentials";

/** How long an authorization request stays claimable by the callback. */
const AUTHORIZATION_REQUEST_TTL_MS = 10 * 60 * 1000; // 10m

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
 * Returns the requested provider's `CLIENT_ID` binding, which the caller needs
 * for the authorization URL. Resolving credentials here also fails an unbound
 * or unsupported provider at the first sign-in rather than on the provider's
 * error page (see {@link getCredentials}).
 */
export const createAuthorizationRequest = mutation({
  args: {
    providerName: v.string(),
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
    const { clientId } = getCredentials(args.providerName);
    await ctx.db.insert("authorizationRequests", {
      ...args,
      expiresAt: Date.now() + AUTHORIZATION_REQUEST_TTL_MS,
    });
    return { clientId };
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
      providerName: v.string(),
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
      providerName: request.providerName,
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
