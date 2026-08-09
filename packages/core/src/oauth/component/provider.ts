import { v } from "convex/values";
import { env, internalMutation, mutation } from "./_generated/server";
import { CALLBACK_PATH } from "./constants";

/** How long an authorization request stays claimable by the callback. */
const AUTHORIZATION_REQUEST_TTL_MS = 10 * 60 * 1000; // 10m

/**
 * Record an in-flight authorization request. Called by the app-side
 * `signIn` before it redirects the user to the provider; the provider
 * callback later claims the request by state hash.
 *
 * Returns the mount's `CLIENT_ID` and the callback URL, which the caller
 * needs for the authorization URL.
 */
export const createAuthorizationRequest = mutation({
  args: {
    providerName: v.string(),
    stateHash: v.string(),
    redirectTo: v.string(),
    codeVerifier: v.optional(v.string()),
    tokenEndpoint: v.string(),
    userInfoEndpoints: v.optional(v.record(v.string(), v.string())),
    issuer: v.optional(v.string()),
  },
  returns: v.object({
    clientId: v.string(),
    callbackUrl: v.string(),
  }),
  handler: async (ctx, args) => {
    // System env vars are only visible inside components on backends with
    // get-convex/convex-backend@64c163a (July 2026); cloud always has it,
    // self-hosted may not.
    // TODO: remove this check when no longer needed.
    const siteUrl = process.env.CONVEX_SITE_URL;
    if (siteUrl === undefined) {
      throw new Error(
        "CONVEX_SITE_URL is not visible inside the oauth component. " +
          "This requires a Convex backend with system env vars in component " +
          "functions (get-convex/convex-backend@64c163a, July 2026).",
      );
    }
    const callbackUrl = `${siteUrl}${CALLBACK_PATH}`;
    await ctx.db.insert("authorizationRequests", {
      ...args,
      callbackUrl,
      expiresAt: Date.now() + AUTHORIZATION_REQUEST_TTL_MS,
    });
    return { clientId: env.CLIENT_ID, callbackUrl };
  },
});

/**
 * The second half of the OAuth flow: after the user authenticates, the
 * provider redirects back to this component's HTTP callback route, which
 * calls this to claim the matching request by state hash.
 *
 * If the request record has expired, it is deleted and its `redirectTo` is
 * returned so the callback can send the user back to the app instead of
 * stranding them on an error page.
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
