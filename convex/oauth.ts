import { ConvexError, v } from "convex/values";

import { mutation } from "./_generated/server";
import { auth } from "./auth";
import { ErrorCode } from "./errors";
import { permissions } from "./roles";

const requestedScopes = v.optional(v.array(v.string()));
const tokenEndpointAuthMethod = v.union(
  v.literal("client_secret_basic"),
  v.literal("client_secret_post"),
  v.literal("none"),
);

function dedupe(scopes: readonly string[]) {
  return [...new Set(scopes)];
}

/**
 * Register an OAuth client (e.g. an MCP server). Returns the public `clientId`
 * and the one-time `clientSecret` — store it securely, it cannot be retrieved
 * later.
 */
export const registerClient = mutation({
  args: {
    name: v.string(),
    redirectUris: v.array(v.string()),
    scopes: requestedScopes,
  },
  returns: v.object({
    clientId: v.string(),
    clientSecret: v.optional(v.string()),
    registrationAccessToken: v.string(),
    tokenEndpointAuthMethod,
  }),
  handler: async (ctx, args) => {
    const identity = await ctx.auth.getUserIdentity();
    if (identity === null) {
      throw new ConvexError({
        code: ErrorCode.NOT_SIGNED_IN,
        message: "Sign in before registering an OAuth client.",
      });
    }

    return await auth.oauth.client.create(ctx, {
      data: {
        name: args.name,
        redirectUris: args.redirectUris,
        scopes: dedupe(args.scopes?.length ? args.scopes : permissions.grants),
        grantTypes: ["authorization_code", "refresh_token"],
        extend: {
          kind: "mcp-demo-client",
          owner: identity.tokenIdentifier,
        },
      },
    });
  },
});

/**
 * Record the signed-in user's authorization of a client (the consent step the
 * `/oauth/authorize` page submits). Mints a single-use code and returns the
 * redirect URL with `code`/`state` to send the client back to.
 */
export const authorize = mutation({
  args: {
    clientId: v.string(),
    redirectUri: v.string(),
    scope: v.optional(v.string()),
    state: v.optional(v.string()),
    codeChallenge: v.string(),
    resource: v.optional(v.string()),
  },
  returns: v.object({ redirect: v.string() }),
  handler: async (ctx, args) => {
    const user = await auth.user.viewer(ctx);
    if (user === null) {
      throw new ConvexError({
        code: ErrorCode.NOT_SIGNED_IN,
        message: "Sign in before authorizing an OAuth client.",
      });
    }

    const requested = args.scope?.split(" ").filter(Boolean);
    const client = requested ? null : await auth.oauth.client.get(ctx, { clientId: args.clientId });
    const scopes = dedupe(requested ?? client?.scopes ?? []);
    const result = await auth.oauth.authorize(ctx, {
      userId: user._id,
      clientId: args.clientId,
      scopes,
      redirectUri: args.redirectUri,
      codeChallenge: args.codeChallenge,
      resource: args.resource,
      state: args.state ?? null,
    });

    const redirect = new URL(result.redirectUri);
    redirect.searchParams.set("code", result.code);
    if (result.state) {
      redirect.searchParams.set("state", result.state);
    }
    return { redirect: redirect.toString() };
  },
});
