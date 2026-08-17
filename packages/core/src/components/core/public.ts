import {
  mutation,
  query,
  MutationCtx,
  QueryCtx,
  env,
} from "./_generated/server";
import { Doc, Id } from "./_generated/dataModel";
import { GenericId, v } from "convex/values";
import { FunctionHandle } from "convex/server";
import {
  vAuthClaims,
  type AuthClaims,
  vTokenBundle,
  type TokenBundle,
  USE_USER_ID_AS_ACCOUNT_ID,
} from "../../lib/types";
import { signJwt, generateRefreshToken } from "./crypto";
import { sha256Hex } from "../../lib/crypto";
import { CreateOrUpdateUserFn } from "../../lib/types";

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
// inside a component the system var arrives prefixed with the mount's
// httpPrefix, so this mount would see `<site-url>/auth`, not the bare site URL
// that auth.config.ts names as the issuer.

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
  const refreshTokenHash = await sha256Hex(refreshToken);
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

type CreateOrUpdateUserFunctionHandle = FunctionHandle<
  CreateOrUpdateUserFn<string, unknown>["_type"],
  CreateOrUpdateUserFn<string, unknown>["_args"],
  CreateOrUpdateUserFn<string, unknown>["_returnType"]
>;

/**
 * Type the given userId string as a {@link GenericId}.
 *
 * The core stores app user ids as opaque strings and has no access to the
 * app's data model. The type for user-supplied callbacks types them as
 * `Id<usersTable>` for the app's benefit, so re-brand on the way back out. The
 * value is the same string either way.
 */
function asUserId(userId: string): GenericId<string> {
  return userId as GenericId<string>;
}

/**
 * Resolve a provider identity to its account, creating one (and the app user
 * behind it) the first time the identity is seen. The app's user callback runs
 * on *every* sign-in: with no `userId` the first time (it mints/returns the
 * user id), and with the known `userId` on every return (so it can sync the
 * user record from the latest claims — the core stores no profile itself, the
 * claims pass through and are otherwise discarded). Returns just what minting a
 * session needs: the account id and its app user id.
 */
async function resolveAccount(
  ctx: MutationCtx,
  claims: AuthClaims,
  createOrUpdateUser: CreateOrUpdateUserFunctionHandle,
): Promise<{ accountId: Id<"accounts">; userId: string }> {
  // `USE_USER_ID_AS_ACCOUNT_ID` means the provider keys the account by the
  // app user id, which does not exist before this sign-in mints it. Such
  // claims can never match an existing account (accounts are never stored
  // with an empty identifier): on later sign-ins the provider puts the user
  // id in the claims itself.
  if (claims.providerAccountId !== USE_USER_ID_AS_ACCOUNT_ID) {
    const account = await accountByIdentity(
      ctx,
      claims.provider,
      claims.providerAccountId,
    );
    if (account) {
      // Returning identity: hand the app the latest claims with the known user
      // id so it can update its own user record.
      if (
        account.userId !==
        (await ctx.runMutation(createOrUpdateUser, {
          provider: claims.provider,
          providerAccountId: claims.providerAccountId,
          profile: claims.profile,
          userId: asUserId(account.userId),
        }))
      ) {
        throw new Error(
          "createOrUpdateUser may not return a new userId for an existing user",
        );
      }
      return { accountId: account._id, userId: account.userId };
    }
  }

  // First sign-in for this identity: ask the app to mint/return its user id,
  // then record the provider-identity -> user mapping.
  const userId = await ctx.runMutation(createOrUpdateUser, {
    provider: claims.provider,
    // With `USE_USER_ID_AS_ACCOUNT_ID` the user id is not minted yet, so
    // there is no meaningful value to hand the app here.
    providerAccountId: claims.providerAccountId,
    profile: claims.profile,
    userId: null,
  });
  const { provider } = claims;
  const providerAccountId =
    claims.providerAccountId === USE_USER_ID_AS_ACCOUNT_ID
      ? userId
      : claims.providerAccountId;
  const existingAccount = await ctx.db
    .query("accounts")
    .withIndex("by_provider_account", (q) =>
      q.eq("provider", provider).eq("providerAccountId", providerAccountId),
    )
    .first();
  if (existingAccount !== null) {
    throw new Error(
      `Invariant violation: an account for provider = ${JSON.stringify(provider)} and provider account ID = ${JSON.stringify(providerAccountId)} already exists`,
    );
  }
  const accountId = await ctx.db.insert("accounts", {
    provider,
    providerAccountId,
    userId,
  });
  return { accountId, userId };
}

// --- Public API ------------------------------------------------------------

/**
 * Exchange a provider's verified identity claims for a session: resolve (or
 * create) the account and its app user, then mint a refresh token + access
 * token. This is the core's entry point for *logging a user in*; each provider
 * calls it (via the app's `completeSignIn`) once it has authenticated the user
 * and produced claims. `createOrUpdateUserHandle` is a handle to the app's
 * user create-or-update mutation, invoked on every sign-in (without a `userId`
 * the first time an identity is seen, with the resolved `userId` thereafter);
 * the JWT is issued with `issuer` as its `iss`. Token lifetimes default to 1m
 * (access) and 30d (refresh) unless `accessTokenTtlSeconds` /
 * `refreshTokenTtlSeconds` are supplied (the app sets these once via `setupCore`).
 */
export const signIn = mutation({
  args: {
    claims: vAuthClaims,
    createOrUpdateUserHandle: v.string(),
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
      args.createOrUpdateUserHandle as CreateOrUpdateUserFunctionHandle,
    );
    return await issueSession(ctx, accountId, userId, args.issuer, ttl);
  },
});

/**
 * Resolve a provider identity to its app user id without minting a session.
 *
 * Providers use this (via the `resolveUserId` helper the core hands them) to look
 * up the user behind a `(provider, providerAccountId)` pair before authenticating
 * — e.g. a password provider needs the user id to verify a stored password *before*
 * a session is issued. Returns `null` when no account exists for the identity.
 *
 * This is a component-internal function (callable by the app, not by end-user
 * clients), so it does not expose account existence to the outside world; the
 * provider's own public API decides what, if anything, to reveal.
 */
export const getUserIdByAccount = query({
  args: { provider: v.string(), providerAccountId: v.string() },
  returns: v.union(v.string(), v.null()),
  handler: async (
    ctx,
    { provider, providerAccountId },
  ): Promise<string | null> => {
    const account = await accountByIdentity(ctx, provider, providerAccountId);
    return account?.userId ?? null;
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
    const hash = await sha256Hex(args.refreshToken);

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
      await ctx.db.delete("sessions", session._id);
      return null;
    }

    const newRefreshToken = generateRefreshToken();
    const newRefreshTokenHash = await sha256Hex(newRefreshToken);
    const refreshTokenExpiresAt = now + ttl.refreshTokenTtlSeconds * 1000;
    // Retain the hash we're replacing as the previous one, valid for the grace
    // window, then swap in the freshly-minted token as current.
    await ctx.db.patch("sessions", session._id, {
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
      await sha256Hex(args.refreshToken),
    );
    if (session) await ctx.db.delete("sessions", session._id);
    return null;
  },
});
