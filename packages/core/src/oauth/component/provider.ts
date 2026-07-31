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
 * The OAuth `redirect_uri` is built here: inside an http-mounted component,
 * `CONVEX_SITE_URL` is the site URL with the mount's `httpPrefix` appended,
 * so the mount in convex.config.ts is the single source of truth for the
 * callback URL. It's stored on the row so the code exchange presents the
 * byte-identical value, as OAuth requires. Other exchange config the
 * callback needs (`tokenEndpoint`, `userInfoEndpoints`) is snapshotted from
 * the caller because the component can't see app-side config.
 *
 * Each mount serves exactly one provider (its `PROVIDER_NAME` binding), so a
 * `provider(...)` wired to the wrong mount fails here at the first sign-in —
 * the one wiring mistake push-time env validation can't catch — rather than
 * confusing the identity provider with another provider's credentials.
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
    if (args.providerName !== env.PROVIDER_NAME) {
      throw new Error(
        `Provider "${args.providerName}" is wired to an oauth mount bound to ` +
          `PROVIDER_NAME "${env.PROVIDER_NAME}". Pass the "${args.providerName}" ` +
          `mount as \`component\` in this provider's options.`,
      );
    }
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
 * calls this to claim the matching request by state hash — find, delete,
 * and return it in one transaction, so a replayed or raced callback finds
 * nothing. An expired row is also deleted, but only its `redirectTo` is
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
