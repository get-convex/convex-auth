import { mutation, query, MutationCtx, env } from "./_generated/server";
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
import * as model from "./model.js";

// --- Configuration ---------------------------------------------------------

// `aud` claim; must match `applicationID` in the app's auth.config.ts.
const AUDIENCE = "convex";
const ACCESS_TOKEN_TTL_SECONDS = 60; // 1 minute
const REFRESH_TOKEN_TTL_MS = 30 * 24 * 60 * 60 * 1000; // 30 days
// How long a just-rotated refresh token stays usable so concurrent refreshes
// presenting it (parallel SSR loaders, two tabs sharing a cookie) don't race
// each other into a forced sign-out.
const REFRESH_GRACE_MS = 30 * 1000; // 30 seconds

// The issuer (CONVEX_SITE_URL) is passed in by the app rather than read here:
// a typed-env component's process.env only contains its bound vars, so the
// system var CONVEX_SITE_URL isn't visible inside the component. It isn't
// secret, so threading it through as an argument is clean and explicit.

// --- Internal helpers ------------------------------------------------------

async function mintAccessToken(userId: string, issuer: string) {
  const privateKeyPkcs8 = atob(env.AUTH_PRIVATE_KEY);
  const { keys } = JSON.parse(env.AUTH_JWKS) as { keys: { kid: string }[] };
  const kid = keys[0].kid;
  return await signJwt({
    privateKeyPkcs8,
    kid,
    subject: userId,
    issuer,
    audience: AUDIENCE,
    expiresInSeconds: ACCESS_TOKEN_TTL_SECONDS,
  });
}

async function issueSession(
  ctx: MutationCtx,
  accountId: Id<"accounts">,
  userId: string,
  issuer: string,
): Promise<TokenBundle> {
  const refreshToken = generateRefreshToken();
  const refreshTokenHash = await hashToken(refreshToken);
  const refreshTokenExpiresAt = Date.now() + REFRESH_TOKEN_TTL_MS;
  await model.createSession(ctx, {
    userId,
    accountId,
    refreshTokenHash,
    refreshTokenExpiresAt,
  });
  const access = await mintAccessToken(userId, issuer);
  return {
    accessToken: access.token,
    accessTokenExpiresAt: access.expiresAt,
    refreshToken,
    refreshTokenExpiresAt,
    userId,
  };
}

// --- Account resolution (sign-in: find the identity, or create its user) -----

/**
 * Resolve a provider identity to its `accounts` row, creating one (and the
 * app user behind it) the first time the identity is seen. On a returning
 * identity the stored profile is refreshed from the latest claims.
 */
async function resolveAccount(
  ctx: MutationCtx,
  claims: AuthClaims,
  createUserHandle: string,
): Promise<Doc<"accounts">> {
  const account = await model.getAccount(
    ctx,
    claims.provider,
    claims.providerAccountId,
  );
  if (account) {
    await model.updateAccountProfile(ctx, account._id, claims.profile);
    return account;
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
  return await model.createAccount(ctx, {
    provider: claims.provider,
    providerAccountId: claims.providerAccountId,
    userId,
    profile: claims.profile,
  });
}

// --- Public API ------------------------------------------------------------

/**
 * Exchange a provider's verified identity claims for a session: resolve (or
 * create) the account and its app user, then mint a refresh token + access
 * token. This is the core's entry point for *logging a user in*; each provider
 * calls it (via the app's `completeSignIn`) once it has authenticated the user
 * and produced claims. `createUserHandle` is a handle to the app's
 * user-creation mutation, used only the first time an identity is seen; the JWT
 * is issued with `issuer` as its `iss`.
 */
export const signIn = mutation({
  args: {
    claims: vAuthClaims,
    createUserHandle: v.string(),
    issuer: v.string(),
  },
  returns: vTokenBundle,
  handler: async (ctx, args): Promise<TokenBundle> => {
    const account = await resolveAccount(
      ctx,
      args.claims,
      args.createUserHandle,
    );
    return await issueSession(ctx, account._id, account.userId, args.issuer);
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
    const account = await model.getAccount(
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
 */
export const linkAccount = mutation({
  args: { claims: vAuthClaims, userId: v.string() },
  returns: vAccountLink,
  handler: async (ctx, args): Promise<AccountLink> => {
    return await model.linkAccount(ctx, {
      provider: args.claims.provider,
      providerAccountId: args.claims.providerAccountId,
      userId: args.userId,
      profile: args.claims.profile,
    });
  },
});

/**
 * Rotate a refresh token and mint a fresh access token. Returns `null` when the
 * session can't be refreshed. That can happen with an unknown token, or one
 * past its refresh-token lifetime. A dead session is a normal outcome the
 * caller should handle by updating its authenticated state.
 */
export const refresh = mutation({
  args: { refreshToken: v.string(), issuer: v.string() },
  returns: v.union(vTokenBundle, v.null()),
  handler: async (ctx, args): Promise<TokenBundle | null> => {
    const now = Date.now();
    const hash = await hashToken(args.refreshToken);

    // Accept either the current hash or a recently-rotated one still inside its
    // grace window (the concurrent-refresh case).
    let session = await model.getSessionByHash(ctx, hash);
    if (!session) {
      const prior = await model.getSessionByPreviousHash(ctx, hash);
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
      await model.deleteSessionByHash(ctx, session.refreshTokenHash);
      return null;
    }

    const newRefreshToken = generateRefreshToken();
    const newRefreshTokenHash = await hashToken(newRefreshToken);
    const refreshTokenExpiresAt = now + REFRESH_TOKEN_TTL_MS;
    // Retain the hash we're replacing as the previous one, valid for the grace
    // window, then swap in the freshly-minted token as current.
    await model.rotateSession(ctx, {
      sessionId: session._id,
      refreshTokenHash: newRefreshTokenHash,
      refreshTokenExpiresAt,
      previousRefreshTokenHash: session.refreshTokenHash,
      previousRefreshTokenExpiresAt: now + REFRESH_GRACE_MS,
    });

    const access = await mintAccessToken(session.userId, args.issuer);
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
    const hash = await hashToken(args.refreshToken);
    await model.deleteSessionByHash(ctx, hash);
    return null;
  },
});
