import {
  mutation,
  query,
  MutationCtx,
  QueryCtx,
  env,
} from "./_generated/server";
import { Doc, Id } from "./_generated/dataModel";
import { v } from "convex/values";
import { FunctionHandle } from "convex/server";
import { vAuthClaims, type AuthClaims } from "../../lib/claims.js";
import {
  vTokenBundle,
  type TokenBundle,
  vAccountResolution,
  type AccountResolution,
  vAccountLink,
  type AccountLink,
} from "../../lib/tokens.js";
import { signJwt, generateRefreshToken, hashToken } from "./crypto.js";

// --- Configuration ---------------------------------------------------------

// `aud` claim; must match `applicationID` in the app's auth.config.ts.
const AUDIENCE = "convex";
// Defaults for the configurable token lifetimes. The app overrides them per
// deployment via `setupCore`, which threads the chosen values in as call args;
// when it passes nothing, these apply.
const DEFAULT_ACCESS_TOKEN_TTL_SECONDS = 60; // 1 minute
const DEFAULT_REFRESH_TOKEN_TTL_SECONDS = 30 * 24 * 60 * 60; // 30 days
// How long a just-rotated refresh token stays usable so concurrent refreshes
// presenting it (parallel SSR loaders, two tabs sharing a cookie) don't race
// each other into a forced sign-out.
const REFRESH_GRACE_MS = 30 * 1000; // 30 seconds

// The issuer (CONVEX_SITE_URL) is passed in by the app rather than read here:
// a typed-env component's process.env only contains its bound vars, so the
// system var CONVEX_SITE_URL isn't visible inside the component. It isn't
// secret, so threading it through as an argument is clean and explicit.

// --- Internal helpers ------------------------------------------------------

/** Look up an account by its provider identity. */
function accountByIdentity(
  ctx: QueryCtx,
  provider: string,
  providerAccountId: string,
): Promise<Doc<"accounts"> | null> {
  return ctx.db
    .query("accounts")
    .withIndex("by_provider_account", (q) =>
      q.eq("provider", provider).eq("providerAccountId", providerAccountId),
    )
    .unique();
}

/** Look up a session by the (current) hash of its refresh token. */
function sessionByHash(
  ctx: QueryCtx,
  refreshTokenHash: string,
): Promise<Doc<"sessions"> | null> {
  return ctx.db
    .query("sessions")
    .withIndex("by_refresh_hash", (q) =>
      q.eq("refreshTokenHash", refreshTokenHash),
    )
    .unique();
}

/**
 * The token lifetimes for a call, with the app's overrides applied over the
 * defaults. Validated so a misconfiguration fails loudly rather than minting
 * nonsensical sessions.
 */
type TtlConfig = {
  accessTokenTtlSeconds: number;
  refreshTokenTtlSeconds: number;
};

function resolveTtlConfig(args: {
  accessTokenTtlSeconds?: number;
  refreshTokenTtlSeconds?: number;
}): TtlConfig {
  const accessTokenTtlSeconds =
    args.accessTokenTtlSeconds ?? DEFAULT_ACCESS_TOKEN_TTL_SECONDS;
  const refreshTokenTtlSeconds =
    args.refreshTokenTtlSeconds ?? DEFAULT_REFRESH_TOKEN_TTL_SECONDS;
  if (accessTokenTtlSeconds <= 0 || refreshTokenTtlSeconds <= 0) {
    throw new Error("Token TTLs must be positive.");
  }
  if (accessTokenTtlSeconds >= refreshTokenTtlSeconds) {
    throw new Error(
      "Access-token TTL must be shorter than the refresh-token TTL.",
    );
  }
  return { accessTokenTtlSeconds, refreshTokenTtlSeconds };
}

async function mintAccessToken(
  userId: string,
  issuer: string,
  ttlSeconds: number,
) {
  const privateKeyPkcs8 = atob(env.AUTH_PRIVATE_KEY);
  const { keys } = JSON.parse(env.AUTH_JWKS) as { keys: { kid: string }[] };
  const kid = keys[0].kid;
  return await signJwt({
    privateKeyPkcs8,
    kid,
    subject: userId,
    issuer,
    audience: AUDIENCE,
    expiresInSeconds: ttlSeconds,
  });
}

async function issueSession(
  ctx: MutationCtx,
  accountId: Id<"accounts">,
  userId: string,
  issuer: string,
  ttl: TtlConfig,
): Promise<TokenBundle> {
  const refreshToken = generateRefreshToken();
  const refreshTokenHash = await hashToken(refreshToken);
  const refreshTokenExpiresAt = Date.now() + ttl.refreshTokenTtlSeconds * 1000;
  await ctx.db.insert("sessions", {
    userId,
    accountId,
    refreshTokenHash,
    refreshTokenExpiresAt,
    lastRefreshedAt: Date.now(),
  });
  const access = await mintAccessToken(
    userId,
    issuer,
    ttl.accessTokenTtlSeconds,
  );
  return {
    accessToken: access.token,
    accessTokenExpiresAt: access.expiresAt,
    refreshToken,
    refreshTokenExpiresAt,
    userId,
  };
}

/**
 * Resolve a provider identity to its account, creating one (and the app user
 * behind it) the first time the identity is seen. On a returning identity the
 * stored profile is refreshed from the latest claims. Returns just what minting
 * a session needs: the account id and its app user id.
 */
async function resolveAccount(
  ctx: MutationCtx,
  claims: AuthClaims,
  createUserHandle: string,
): Promise<{ accountId: Id<"accounts">; userId: string }> {
  const account = await accountByIdentity(
    ctx,
    claims.provider,
    claims.providerAccountId,
  );
  if (account) {
    await ctx.db.patch(account._id, { profile: claims.profile });
    return { accountId: account._id, userId: account.userId };
  }

  // First sign-in for this identity: ask the app to mint/return its user id,
  // then record the provider-identity -> user mapping.
  const createUser = createUserHandle as FunctionHandle<
    "mutation",
    {
      provider: string;
      providerAccountId: string;
      profile: Record<string, unknown>;
    },
    string
  >;
  const userId = await ctx.runMutation(createUser, {
    provider: claims.provider,
    providerAccountId: claims.providerAccountId,
    profile: claims.profile,
  });
  const accountId = await ctx.db.insert("accounts", {
    provider: claims.provider,
    providerAccountId: claims.providerAccountId,
    userId,
    profile: claims.profile,
  });
  return { accountId, userId };
}

// --- Public API ------------------------------------------------------------

/**
 * Exchange a provider's verified identity claims for a session: resolve (or
 * create) the account and its app user, then mint a refresh token + access
 * token. This is the core's entry point for *logging a user in*; each provider
 * calls it (via the app's `completeSignIn`) once it has authenticated the user
 * and produced claims. `createUserHandle` is a handle to the app's
 * user-creation mutation, used only the first time an identity is seen; the JWT
 * is issued with `issuer` as its `iss`. Token lifetimes default to 1m (access)
 * and 30d (refresh) unless `accessTokenTtlSeconds` / `refreshTokenTtlSeconds` are
 * supplied (the app sets these once via `setupCore`).
 */
export const signIn = mutation({
  args: {
    claims: vAuthClaims,
    createUserHandle: v.string(),
    issuer: v.string(),
    accessTokenTtlSeconds: v.optional(v.number()),
    refreshTokenTtlSeconds: v.optional(v.number()),
  },
  returns: vTokenBundle,
  handler: async (ctx, args): Promise<TokenBundle> => {
    const ttl = resolveTtlConfig(args);
    const { accountId, userId } = await resolveAccount(
      ctx,
      args.claims,
      args.createUserHandle,
    );
    return await issueSession(ctx, accountId, userId, args.issuer, ttl);
  },
});

/**
 * Resolve a provider identity *without* minting a session: report whether the
 * identity is already linked to an app user, echoing the claims back alongside
 * any `existingUserId`. This is the read-only counterpart to `signIn`.
 */
export const authenticate = query({
  args: { claims: vAuthClaims },
  returns: vAccountResolution,
  handler: async (ctx, args): Promise<AccountResolution> => {
    const account = await accountByIdentity(
      ctx,
      args.claims.provider,
      args.claims.providerAccountId,
    );
    return {
      provider: args.claims.provider,
      providerAccountId: args.claims.providerAccountId,
      profile: args.claims.profile,
      existingUserId: account?.userId,
    };
  },
});

/**
 * Link a provider identity to an already-existing user (no session is minted).
 *
 * Idempotent: if the identity is already linked to `userId`, the profile is
 * refreshed and `linked: false` is returned. Linking an identity that already
 * belongs to a *different* user is rejected.
 */
export const linkAccount = mutation({
  args: { claims: vAuthClaims, userId: v.string() },
  returns: vAccountLink,
  handler: async (ctx, args): Promise<AccountLink> => {
    const { provider, providerAccountId, profile } = args.claims;
    const existing = await accountByIdentity(ctx, provider, providerAccountId);
    if (existing) {
      if (existing.userId !== args.userId) {
        throw new Error("This identity is already linked to a different user.");
      }
      await ctx.db.patch(existing._id, { profile });
      return { linked: false, userId: existing.userId };
    }
    await ctx.db.insert("accounts", {
      provider,
      providerAccountId,
      userId: args.userId,
      profile,
    });
    return { linked: true, userId: args.userId };
  },
});

/**
 * Rotate a refresh token and mint a fresh access token. Returns `null` when the
 * session can't be refreshed. That can happen with an unknown token, or one
 * past its refresh-token lifetime. A dead session is a normal outcome the
 * caller should handle by updating its authenticated state.
 */
export const refresh = mutation({
  args: {
    refreshToken: v.string(),
    issuer: v.string(),
    accessTokenTtlSeconds: v.optional(v.number()),
    refreshTokenTtlSeconds: v.optional(v.number()),
  },
  returns: v.union(vTokenBundle, v.null()),
  handler: async (ctx, args): Promise<TokenBundle | null> => {
    const ttl = resolveTtlConfig(args);
    const now = Date.now();
    const hash = await hashToken(args.refreshToken);

    // Accept either the current hash or a recently-rotated one still inside its
    // grace window (the concurrent-refresh case).
    let session = await sessionByHash(ctx, hash);
    if (!session) {
      const prior = await ctx.db
        .query("sessions")
        .withIndex("by_previous_refresh_hash", (q) =>
          q.eq("previousRefreshTokenHash", hash),
        )
        .unique();
      if (
        prior &&
        prior.previousRefreshTokenExpiresAt !== undefined &&
        prior.previousRefreshTokenExpiresAt >= now
      ) {
        session = prior;
      }
    }
    // Unknown token: no session to refresh, and nothing to clean up.
    if (!session) return null;
    if (session.refreshTokenExpiresAt < now) {
      // Past its refresh-token lifetime: delete the dead row and report no
      // session.
      await ctx.db.delete(session._id);
      return null;
    }

    const newRefreshToken = generateRefreshToken();
    const newRefreshTokenHash = await hashToken(newRefreshToken);
    const refreshTokenExpiresAt = now + ttl.refreshTokenTtlSeconds * 1000;
    // Retain the hash we're replacing as the previous one, valid for the grace
    // window, then swap in the freshly-minted token as current.
    await ctx.db.patch(session._id, {
      refreshTokenHash: newRefreshTokenHash,
      refreshTokenExpiresAt,
      previousRefreshTokenHash: session.refreshTokenHash,
      previousRefreshTokenExpiresAt: now + REFRESH_GRACE_MS,
      lastRefreshedAt: now,
    });

    const access = await mintAccessToken(
      session.userId,
      args.issuer,
      ttl.accessTokenTtlSeconds,
    );
    return {
      accessToken: access.token,
      accessTokenExpiresAt: access.expiresAt,
      refreshToken: newRefreshToken,
      refreshTokenExpiresAt,
      userId: session.userId,
    };
  },
});

/** Revoke a session (sign out). Idempotent. */
export const signOut = mutation({
  args: { refreshToken: v.string() },
  returns: v.null(),
  handler: async (ctx, args) => {
    const session = await sessionByHash(
      ctx,
      await hashToken(args.refreshToken),
    );
    if (session) await ctx.db.delete(session._id);
    return null;
  },
});
