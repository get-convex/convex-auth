import { v } from "convex/values";
import { mutation } from "./_generated/server";

/** How long an authorization request stays claimable by the callback. */
const AUTHORIZATION_REQUEST_TTL_MS = 10 * 60 * 1000;

/**
 * Record an in-flight authorization request. Called by the app-side `signIn`
 * before it redirects the user to the provider; the provider callback later
 * claims the request by state hash.
 *
 * Returns the component's mounted base URL (`process.env.CONVEX_SITE_URL` is
 * overridden inside components to include the `httpPrefix` the app mounted
 * the component under), which the caller needs to construct the OAuth
 * `redirect_uri`.
 */
export const createAuthorizationRequest = mutation({
  args: {
    provider: v.string(),
    stateHash: v.string(),
    redirectTo: v.string(),
    codeVerifier: v.optional(v.string()),
  },
  returns: v.string(),
  handler: async (ctx, args) => {
    const siteUrl = process.env.CONVEX_SITE_URL;
    if (siteUrl === undefined) {
      throw new Error("CONVEX_SITE_URL is not set");
    }
    await ctx.db.insert("authorizationRequests", {
      ...args,
      expiresAt: Date.now() + AUTHORIZATION_REQUEST_TTL_MS,
    });
    return siteUrl;
  },
});
