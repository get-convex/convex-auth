import {
  mutation,
  query,
  MutationCtx,
  QueryCtx,
  env,
} from "./_generated/server.ts";
import { Doc, Id } from "./_generated/dataModel.ts";
import { GenericId, v } from "convex/values";
import { FunctionHandle } from "convex/server";
import {
  vAuthClaims,
  type AuthClaims,
  vTokenBundle,
  type TokenBundle,
  USE_USER_ID_AS_ACCOUNT_ID,
  vProviderSignInOutcome,
  type ProviderSignInOutcome,
  vProviderContinueOutcome,
  type ProviderContinueOutcome,
  vProviderRequirement,
  type ProviderRequirement,
  type SignInRequirement,
  vAttemptContext,
} from "../../lib/types.ts";
import { signJwt, generateRefreshToken } from "./crypto.ts";
import { sha256Hex } from "../../lib/crypto.ts";
import { CreateUserFn, OnSignInFn } from "../../lib/types.ts";

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
// each other into a forced sign-out. Past this, presenting a rotated-away
// token is treated as theft — see `sessionBySpentHash`.
export const REFRESH_GRACE_MS = 30 * 1000; // 30 seconds
// How long a spent refresh token hash is remembered. This is the
// reuse-detection horizon: past it the row is gone and a replayed token reads
// as unknown, which revokes nothing but also grants nothing.
export const SPENT_TOKEN_HORIZON_MS = 60 * 60 * 1000; // 1 hour
// How long a parked incomplete sign-in stays continuable. Long enough for a
// user to answer a challenge, short enough that parked sign-ins don't linger.
const ATTEMPT_TTL_MS = 10 * 60 * 1000; // 10 minutes
// How many times a single attempt may be continued (or penalized) before it
// is discarded — a brute-force/looping guard (e.g. guessing a second-factor
// challenge).
const MAX_CONTINUE_COUNT = 10;

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

/**
 * Look up a session by the hash of its refresh token.
 *
 * Returns an object with the session (if found) and an `isValid` boolean value.
 *
 * A session is invalid if the refresh token is expired.
 */
async function sessionByHash(
  ctx: QueryCtx,
  refreshTokenHash: string,
): Promise<{ session: Doc<"sessions"> | null; isValid: boolean }> {
  const session = await ctx.db
    .query("sessions")
    .withIndex("by_refresh_hash", (q) =>
      q.eq("refreshTokenHash", refreshTokenHash),
    )
    .unique();
  const now = Date.now();
  return {
    session,
    isValid: session !== null && session.refreshTokenExpiresAt > now,
  };
}

/**
 * Look up data for a refresh token that has been previously used.
 *
 * The returned document stores the refresh time via the `_creationTime` field
 * as well as the associated `sessionId`.
 */
function spentTokenByHash(
  ctx: QueryCtx,
  hash: string,
): Promise<Doc<"spentRefreshTokens"> | null> {
  return ctx.db
    .query("spentRefreshTokens")
    .withIndex("by_hash", (q) => q.eq("hash", hash))
    .unique();
}

/**
 * Erase a session along with every spent refresh hash that points at it.
 *
 * Idempotent, because callers can race: two replays of the same stolen token,
 * or a sign-out arriving alongside one, can both resolve the same session.
 */
async function deleteSession(
  ctx: MutationCtx,
  sessionId: Id<"sessions">,
): Promise<void> {
  // Reads every spent row the session has. That is fine at any plausible refresh
  // rate — the horizon divided by the refresh interval, ~60 at the defaults — but
  // it is unbounded in principle. A session refreshed pathologically often
  // could exceed the transaction's limits and make the session unusable.
  const spent = await ctx.db
    .query("spentRefreshTokens")
    .withIndex("by_session", (q) => q.eq("sessionId", sessionId))
    .collect();
  for (const row of spent) {
    await ctx.db.delete("spentRefreshTokens", row._id);
  }
  // `delete` throws on an id that is already gone, and the session may have
  // been deleted by whoever we raced.
  if ((await ctx.db.get("sessions", sessionId)) !== null) {
    await ctx.db.delete("sessions", sessionId);
  }
}

/**
 * Erase this session's spent hashes that are past the detection horizon.
 *
 * Spent tokens are used to allow concurrent refreshes within a grace window
 * and to detect illegitamite use of a refresh token. Only a bounded set of
 * tokens is kept for that purpose though, thus this code to prune documents
 * older than the `SPENT_TOKEN_HORIZON_MS`.
 *
 * Cleanup is triggered by token rotation, so a steadily refreshing session
 * keeps its own set trimmed with no background job to run or mount.
 */
async function pruneSpentTokens(
  ctx: MutationCtx,
  sessionId: Id<"sessions">,
  now: number,
): Promise<void> {
  // A session that stops refreshing keeps its remaining rows until it is
  // deleted, since nothing rotates it any more. Sweeping those orphans is what a
  // background job would add; see KNOWN_ISSUES.md.
  const spent = await ctx.db
    .query("spentRefreshTokens")
    .withIndex("by_session", (q) =>
      q
        .eq("sessionId", sessionId)
        .lte("_creationTime", now - SPENT_TOKEN_HORIZON_MS),
    )
    .collect();
  for (const row of spent) {
    await ctx.db.delete("spentRefreshTokens", row._id);
  }
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
  if (refreshTokenTtlSeconds * 1000 < REFRESH_GRACE_MS * 2) {
    throw new Error(
      `Refresh-token TTL must be at least ${(REFRESH_GRACE_MS / 1000) * 2} seconds`,
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

type CreateUserFunctionHandle = FunctionHandle<
  CreateUserFn<string, unknown>["_type"],
  CreateUserFn<string, unknown>["_args"],
  CreateUserFn<string, unknown>["_returnType"]
>;

type OnSignInFunctionHandle = FunctionHandle<
  OnSignInFn<string, unknown>["_type"],
  OnSignInFn<string, unknown>["_args"],
  OnSignInFn<string, unknown>["_returnType"]
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
 * Create the account and app-level user for an identity the core has not seen before.
 *
 * The app's `createUser` callback mints and returns the user id, and this
 * records the provider-identity -> user mapping. Returns what minting a
 * session needs: the account id and its app user id. The claims are passed to
 * the `createUser` callback.
 *
 */
async function createAccount(
  ctx: MutationCtx,
  claims: AuthClaims,
  createUser: CreateUserFunctionHandle,
): Promise<{ accountId: Id<"accounts">; userId: string }> {
  // `USE_USER_ID_AS_ACCOUNT_ID` means the account is keyed by the app user id,
  // which does not exist until the callback below mints it. Such claims can
  // never match an existing account (accounts are never stored with an empty
  // identifier), so there is nothing to check yet; the pre-insert check below
  // covers that path once the key is known.
  if (claims.providerAccountId !== USE_USER_ID_AS_ACCOUNT_ID) {
    const account = await accountByIdentity(
      ctx,
      claims.provider,
      claims.providerAccountId,
    );
    if (account !== null) {
      // Creating an account for an identity that already has one would mint a
      // second app user for someone who already has one. Fail before calling
      // the app.
      throw new Error(
        `Cannot create an account: an account for provider = ${JSON.stringify(claims.provider)} ` +
          `and provider account ID = ${JSON.stringify(claims.providerAccountId)} already ` +
          `exists. Providers that cannot tell a first sign-in from a return visit must ` +
          `look the identity up (getUserIdByAccount) and call signIn instead.`,
      );
    }
  }

  const userId = await ctx.runMutation(createUser, {
    provider: claims.provider,
    providerAccountId: claims.providerAccountId,
    profile: claims.profile,
  });
  const { provider } = claims;
  const providerAccountId =
    claims.providerAccountId === USE_USER_ID_AS_ACCOUNT_ID
      ? userId
      : claims.providerAccountId;
  // The last word on uniqueness, for the `USE_USER_ID_AS_ACCOUNT_ID` path,
  // whose key is only known now. Redundant for every other path, and cheap.
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

// --- Sign-in attempts (incomplete sign-ins) ---------------------------------

/** Look up the (at most one) pending attempt for a provider identity. */
function attemptByIdentity(
  ctx: QueryCtx,
  provider: string,
  providerAccountId: string,
): Promise<Doc<"pendingSignInAttempts"> | null> {
  return ctx.db
    .query("pendingSignInAttempts")
    .withIndex("by_provider_account", (q) =>
      q.eq("provider", provider).eq("providerAccountId", providerAccountId),
    )
    .unique();
}

/**
 * Load the live attempt a bearer token names, or `null` — deleting the row —
 * when the token is unknown, the attempt has expired, or it is over its
 * continuation cap. Shared by {@link continueSignIn} and the fact primitives
 * below so every touch applies the same hygiene.
 */
async function liveAttemptByToken(
  ctx: MutationCtx,
  attemptToken: string,
): Promise<Doc<"pendingSignInAttempts"> | null> {
  const attemptTokenHash = await sha256Hex(attemptToken);
  const attempt = await ctx.db
    .query("pendingSignInAttempts")
    .withIndex("by_token_hash", (q) =>
      q.eq("attemptTokenHash", attemptTokenHash),
    )
    .unique();
  if (attempt === null) return null;
  if (
    attempt.expiresAt < Date.now() ||
    attempt.continueCount >= MAX_CONTINUE_COUNT
  ) {
    await ctx.db.delete("pendingSignInAttempts", attempt._id);
    return null;
  }
  return attempt;
}

/**
 * Run one round of sign-in evaluation and collect the outstanding
 * requirements.
 *
 * Two checks compose, in a fixed order:
 *
 *  1. *Provider-registered* requirements (injected by the provider's setup
 *     from its config options) are checked by the framework itself: one is
 *     outstanding until every one of its `factFields` is present in the
 *     attempt's provider-scoped facts bag.
 *  2. The app's `onSignIn` callback, when one is attached, judges the
 *     sign-in against the app-scoped facts bag and returns its verdict. An
 *     app with no requirements returns `null` every time, which is how a
 *     plain per-sign-in hook and a full evaluator are the same callback.
 *
 * The two facts bags are disjoint on purpose: the app's callback never sees
 * provider facts, so its strictly-validated `facts` arg can't be broken by
 * fields it never declared. A provider-registered requirement is therefore
 * checked even when the app attached no callback at all.
 *
 * The callback runs on *every* round — first sign-in, returning sign-in, and
 * each continuation — and is deliberately blind to which round this is: it
 * judges `(user, profile, facts)` and nothing else. `providerAccountId` is
 * always the *resolved* id (the attempt's key), never a sign-up placeholder.
 */
async function evaluateSignIn(
  ctx: MutationCtx,
  identity: { provider: string; providerAccountId: string; profile: unknown },
  userId: string,
  facts: Record<string, unknown>,
  providerFacts: Record<string, unknown>,
  onSignInHandle: OnSignInFunctionHandle | undefined,
  providerRequirements: ProviderRequirement[],
): Promise<SignInRequirement[]> {
  const outstanding = providerRequirements
    .filter(
      (requirement) =>
        !requirement.factFields.every(
          (field) => providerFacts[field] !== undefined,
        ),
    )
    .map((requirement) => ({
      kind: requirement.kind,
      data: requirement.data,
    }));
  if (onSignInHandle === undefined) return outstanding;
  const verdict = await ctx.runMutation(onSignInHandle, {
    provider: identity.provider,
    providerAccountId: identity.providerAccountId,
    profile: identity.profile,
    userId: asUserId(userId),
    facts,
  });
  return [...outstanding, ...(verdict === null ? [] : verdict.requirements)];
}

/**
 * Finish a *fresh* (non-continuation) sign-in round: evaluate with empty
 * facts bags, then either mint the session or park the sign-in as an attempt.
 *
 * Any pending attempt for the identity is superseded either way: a fresh
 * sign-in that completes deletes it, and one that stays incomplete replaces
 * it wholesale — new token, facts reset (a fresh sign-in re-proves its
 * factors, the conservative default), continuation budget restored. That
 * also means a second device signing in invalidates the first device's
 * attempt token.
 */
async function finishSignIn(
  ctx: MutationCtx,
  opts: {
    identity: {
      provider: string;
      providerAccountId: string;
      profile: unknown;
    };
    accountId: Id<"accounts">;
    userId: string;
    onSignInHandle: OnSignInFunctionHandle | undefined;
    providerRequirements: ProviderRequirement[];
    issuer: string;
    ttl: TtlConfig;
  },
): Promise<ProviderSignInOutcome> {
  const { identity, userId } = opts;
  const pending = await attemptByIdentity(
    ctx,
    identity.provider,
    identity.providerAccountId,
  );
  const requirements = await evaluateSignIn(
    ctx,
    identity,
    userId,
    {},
    {},
    opts.onSignInHandle,
    opts.providerRequirements,
  );

  if (requirements.length === 0) {
    if (pending !== null) {
      await ctx.db.delete("pendingSignInAttempts", pending._id);
    }
    const tokens = await issueSession(
      ctx,
      opts.accountId,
      userId,
      opts.issuer,
      opts.ttl,
    );
    return { status: "session-created", tokens };
  }

  const attemptToken = generateRefreshToken();
  const attempt = {
    provider: identity.provider,
    providerAccountId: identity.providerAccountId,
    profile: identity.profile,
    // Filled in by `recordAttemptFacts` as verification endpoints succeed; a
    // fresh sign-in always starts with empty bags.
    facts: {},
    providerFacts: {},
    userId,
    attemptTokenHash: await sha256Hex(attemptToken),
    expiresAt: Date.now() + ATTEMPT_TTL_MS,
    continueCount: 0,
  };
  if (pending !== null) {
    await ctx.db.patch("pendingSignInAttempts", pending._id, attempt);
  } else {
    await ctx.db.insert("pendingSignInAttempts", attempt);
  }
  return {
    status: "pending-requirements",
    requirements,
    attemptToken,
    expiresAt: attempt.expiresAt,
    userId,
  };
}

// --- Component API ------------------------------------------------------------

/**
 * Performs an app-integrated new user sign-up.
 *
 * Establishes a session and returns a token bundle upon success.
 *
 * Providers don't typically call this API directly, but instead use the
 * framework's `completeSignUp` helper. That function takes care of passing the
 * `createUserHandle` and `onSignInHandle` app callbacks.
 *
 * `createUser` mints the app user, then `onSignIn` runs like it does for any
 * other sign-in. An `onSignIn` that throws therefore rolls back the user
 * `createUser` just made, since both are subtransactions of this one.
 *
 * The sign-in may come back `pending-requirements` when requirements are outstanding —
 * the app's `onSignIn` asked for more, or a provider-registered requirement
 * is unmet. The user and account are created eagerly either way, and only the
 * session is withheld, which makes abandoned incomplete sign-ups
 * self-healing: signing *in* later resolves the same user and re-prompts,
 * instead of failing or minting a duplicate.
 *
 * The JWT accessToken in the return value is issued with `issuer` as its
 * `iss`. Token lifetimes default to 1m (access) and 30d (refresh) unless
 * `accessTokenTtlSeconds` / `refreshTokenTtlSeconds` are supplied (the app
 * sets these once via `setupCore`).
 *
 * Throws when the identity already has an account. See {@link signIn} for the
 * return-visit path.
 */
export const signUp = mutation({
  args: {
    claims: vAuthClaims,
    createUserHandle: v.string(),
    onSignInHandle: v.optional(v.string()),
    providerRequirements: v.optional(v.array(vProviderRequirement)),
    issuer: v.string(),
    accessTokenTtlSeconds: v.optional(v.number()),
    refreshTokenTtlSeconds: v.optional(v.number()),
  },
  returns: vProviderSignInOutcome,
  handler: async (ctx, args): Promise<ProviderSignInOutcome> => {
    const ttl = resolveTtlConfig(args);
    const { accountId, userId } = await createAccount(
      ctx,
      args.claims,
      args.createUserHandle as CreateUserFunctionHandle,
    );
    return await finishSignIn(ctx, {
      identity: {
        provider: args.claims.provider,
        // The resolved key, which for USE_USER_ID_AS_ACCOUNT_ID providers is
        // the user id `createUser` just minted — evaluation always sees (and
        // attempts are always keyed by) the resolved id, never the sign-up
        // placeholder.
        providerAccountId:
          args.claims.providerAccountId === USE_USER_ID_AS_ACCOUNT_ID
            ? userId
            : args.claims.providerAccountId,
        profile: args.claims.profile,
      },
      accountId,
      userId,
      onSignInHandle: args.onSignInHandle as OnSignInFunctionHandle | undefined,
      providerRequirements: args.providerRequirements ?? [],
      issuer: args.issuer,
      ttl,
    });
  },
});

/**
 * Performs an app-integrated user sign-in.
 *
 * Establishes a session and returns a token bundle upon success.
 *
 * Providers don't typically call this API directly, but instead use the
 * framework's `completeSignIn` helper. That function takes care of passing the
 * `onSignInHandle` app callback.
 *
 * The JWT accessToken in the return value is issued with `issuer` as its
 * `iss`. Token lifetimes default to 1m (access) and 30d (refresh) unless
 * `accessTokenTtlSeconds` / `refreshTokenTtlSeconds` are supplied (the app
 * sets these once via `setupCore`).
 *
 * The sign-in may come back `pending-requirements` when requirements are outstanding:
 * no session is minted, the sign-in is parked as an attempt, and the returned
 * `attemptToken` continues it via {@link continueSignIn}. An identity has at
 * most one live attempt — a fresh sign-in supersedes it.
 *
 * Throws when the identity has no account.
 */
export const signIn = mutation({
  args: {
    claims: vAuthClaims,
    onSignInHandle: v.optional(v.string()),
    providerRequirements: v.optional(v.array(vProviderRequirement)),
    issuer: v.string(),
    accessTokenTtlSeconds: v.optional(v.number()),
    refreshTokenTtlSeconds: v.optional(v.number()),
  },
  returns: vProviderSignInOutcome,
  handler: async (ctx, args): Promise<ProviderSignInOutcome> => {
    const ttl = resolveTtlConfig(args);
    const { claims } = args;
    const account = await accountByIdentity(
      ctx,
      claims.provider,
      claims.providerAccountId,
    );
    if (account === null) {
      throw new Error(
        `Cannot sign in: no account for provider = ${JSON.stringify(claims.provider)} ` +
          `and provider account ID = ${JSON.stringify(claims.providerAccountId)} exists. ` +
          `A first sign-in for an identity must go through signUp.`,
      );
    }
    return await finishSignIn(ctx, {
      identity: {
        provider: claims.provider,
        providerAccountId: claims.providerAccountId,
        profile: claims.profile,
      },
      accountId: account._id,
      userId: account.userId,
      onSignInHandle: args.onSignInHandle as OnSignInFunctionHandle | undefined,
      providerRequirements: args.providerRequirements ?? [],
      issuer: args.issuer,
      ttl,
    });
  },
});

/**
 * Continue a parked sign-in attempt, re-running evaluation against the facts
 * verification endpoints have recorded since the last round.
 *
 * When nothing is outstanding anymore the attempt is deleted and a session
 * minted; otherwise the attempt burns one unit of continuation budget and
 * reports the remaining requirements (its token and expiry are unchanged —
 * continuing never extends an attempt's lifetime). Returns `expired` —
 * deleting the row where one exists — for an unknown token, an attempt past
 * its lifetime, or one over its continuation cap; the caller should restart
 * the sign-in from scratch.
 *
 * The attempt token is the continuation credential: random, stored only as a
 * hash, short-lived, and budgeted. Providers do not re-verify their own
 * factor (the password, say) on continuation.
 */
export const continueSignIn = mutation({
  args: {
    attemptToken: v.string(),
    onSignInHandle: v.optional(v.string()),
    providerRequirements: v.optional(v.array(vProviderRequirement)),
    issuer: v.string(),
    accessTokenTtlSeconds: v.optional(v.number()),
    refreshTokenTtlSeconds: v.optional(v.number()),
  },
  returns: vProviderContinueOutcome,
  handler: async (ctx, args): Promise<ProviderContinueOutcome> => {
    const ttl = resolveTtlConfig(args);
    const attempt = await liveAttemptByToken(ctx, args.attemptToken);
    if (attempt === null) return { status: "expired" };

    const requirements = await evaluateSignIn(
      ctx,
      {
        provider: attempt.provider,
        providerAccountId: attempt.providerAccountId,
        profile: attempt.profile,
      },
      attempt.userId,
      (attempt.facts ?? {}) as Record<string, unknown>,
      (attempt.providerFacts ?? {}) as Record<string, unknown>,
      args.onSignInHandle as OnSignInFunctionHandle | undefined,
      args.providerRequirements ?? [],
    );

    if (requirements.length === 0) {
      await ctx.db.delete("pendingSignInAttempts", attempt._id);
      const account = await accountByIdentity(
        ctx,
        attempt.provider,
        attempt.providerAccountId,
      );
      if (account === null) {
        // Accounts are created eagerly before any attempt is parked, so a
        // missing one means the account was deleted mid-flow.
        throw new Error(
          `Invariant violation: no account for provider = ${JSON.stringify(attempt.provider)} ` +
            `and provider account ID = ${JSON.stringify(attempt.providerAccountId)} ` +
            `behind a live sign-in attempt`,
        );
      }
      const tokens = await issueSession(
        ctx,
        account._id,
        attempt.userId,
        args.issuer,
        ttl,
      );
      return { status: "session-created", tokens };
    }

    await ctx.db.patch("pendingSignInAttempts", attempt._id, {
      continueCount: attempt.continueCount + 1,
    });
    return {
      status: "pending-requirements",
      requirements,
      attemptToken: args.attemptToken,
      expiresAt: attempt.expiresAt,
      userId: attempt.userId,
    };
  },
});

// --- Verification-fact primitives --------------------------------------------
//
// The building blocks for endpoints that *verify* a requirement server-side
// (a second factor, a CAPTCHA, an email link) and record the proof as a fact
// on the pending attempt. Like every function here they are
// component-internal — callable from app/provider server code, never from
// clients — so the only path to a recorded fact runs through whatever
// verification the calling endpoint performed. The shape of such an endpoint:
//
//   1. `getAttemptContext` — resolve the attempt's *subject* and verify
//      against it (never against caller-supplied identity).
//   2. On success: `recordAttemptFacts` — the evaluator sees the fact on the
//      next round and stops demanding the requirement.
//   3. On failure: `penalizeAttempt` — a failed verification must burn
//      continuation budget, or the endpoint is an unmetered guessing oracle.

/**
 * Resolve a live attempt's subject: which provider identity is mid-sign-in
 * and which user the flow is anchored to. Returns `null` for an unknown,
 * expired or over-cap token (surface that as "start over").
 *
 * A query, so it cannot lazily delete a dead attempt the way mutating
 * touches do — the row is simply treated as gone.
 */
export const getAttemptContext = query({
  args: { attemptToken: v.string() },
  returns: v.union(vAttemptContext, v.null()),
  handler: async (ctx, args) => {
    const attemptTokenHash = await sha256Hex(args.attemptToken);
    const attempt = await ctx.db
      .query("pendingSignInAttempts")
      .withIndex("by_token_hash", (q) =>
        q.eq("attemptTokenHash", attemptTokenHash),
      )
      .unique();
    if (
      attempt === null ||
      attempt.expiresAt < Date.now() ||
      attempt.continueCount >= MAX_CONTINUE_COUNT
    ) {
      return null;
    }
    return {
      provider: attempt.provider,
      providerAccountId: attempt.providerAccountId,
      userId: attempt.userId,
    };
  },
});

/**
 * Record verification facts on a pending attempt (shallow merge, later
 * writes win). This is the *only* write path into the trusted facts bags —
 * there is no client-writable channel into either. `scope` picks the bag:
 * `"app"` (the default) is what the app's evaluator reads; `"provider"`
 * backs provider-registered requirements and stays invisible to the app.
 * Returns `false` when the attempt is gone (unknown/expired/over-cap) — the
 * verification succeeded but there is nothing left to record it on, so the
 * caller should surface "start over".
 */
export const recordAttemptFacts = mutation({
  args: {
    attemptToken: v.string(),
    facts: v.any(),
    scope: v.optional(v.union(v.literal("app"), v.literal("provider"))),
  },
  returns: v.boolean(),
  handler: async (ctx, args): Promise<boolean> => {
    const attempt = await liveAttemptByToken(ctx, args.attemptToken);
    if (attempt === null) return false;
    const scope = args.scope ?? "app";
    if (scope === "provider") {
      await ctx.db.patch("pendingSignInAttempts", attempt._id, {
        providerFacts: {
          ...(attempt.providerFacts ?? {}),
          ...(args.facts ?? {}),
        },
      });
    } else {
      await ctx.db.patch("pendingSignInAttempts", attempt._id, {
        facts: { ...(attempt.facts ?? {}), ...(args.facts ?? {}) },
      });
    }
    return true;
  },
});

/**
 * Meter a *failed* verification against the attempt's continuation cap.
 * Successes are self-limiting (there are only so many facts to record);
 * failures are the brute-force surface, and only reach the core through this
 * call. Returns `false` when the attempt was already gone or this failure
 * exhausted the cap (the row is deleted either way it dies).
 */
export const penalizeAttempt = mutation({
  args: { attemptToken: v.string() },
  returns: v.boolean(),
  handler: async (ctx, args): Promise<boolean> => {
    const attempt = await liveAttemptByToken(ctx, args.attemptToken);
    if (attempt === null) return false;
    const continueCount = attempt.continueCount + 1;
    if (continueCount >= MAX_CONTINUE_COUNT) {
      await ctx.db.delete("pendingSignInAttempts", attempt._id);
      return false;
    }
    await ctx.db.patch("pendingSignInAttempts", attempt._id, { continueCount });
    return true;
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
 * Mint a new refresh token for a live session.
 *
 * The prior refresh token hash for the session goes into the
 * `spentRefreshTokens` table, which lets a later presentation of it be
 * recognized as either a concurrent refresh within the `REFRESH_GRACE_MS`
 * window or an invalid usage (potential stolen token) that should end the
 * session.
 */
async function rotateSession(
  ctx: MutationCtx,
  session: Doc<"sessions">,
  now: number,
  issuer: string,
  ttl: TtlConfig,
): Promise<TokenBundle> {
  const newRefreshToken = generateRefreshToken();
  const newRefreshTokenHash = await sha256Hex(newRefreshToken);
  const refreshTokenExpiresAt = now + ttl.refreshTokenTtlSeconds * 1000;
  await ctx.db.insert("spentRefreshTokens", {
    hash: session.refreshTokenHash,
    sessionId: session._id,
  });
  await ctx.db.patch("sessions", session._id, {
    refreshTokenHash: newRefreshTokenHash,
    refreshTokenExpiresAt,
    lastRefreshedAt: now,
  });

  // Remove any spent tokens past the `SPENT_TOKEN_HORIZON_MS`.
  await pruneSpentTokens(ctx, session._id, now);

  const access = await mintAccessToken(
    session.userId,
    issuer,
    ttl.accessTokenTtlSeconds,
  );
  return {
    accessToken: access.token,
    accessTokenExpiresAt: access.expiresAt,
    refreshToken: newRefreshToken,
    refreshTokenExpiresAt,
    userId: session.userId,
  };
}

/**
 * Looks up a session by a spent refresh token hash.
 *
 * Returns an object with the session (if found) and an `isValid` boolean value.
 *
 * A session is invalid if the spent token hash is used past the grace window
 * or if the current refresh token for the session is expired.
 */
async function sessionBySpentHash(
  ctx: MutationCtx,
  hash: string,
): Promise<{ session: Doc<"sessions"> | null; isValid: boolean }> {
  const spent = await spentTokenByHash(ctx, hash);
  // A token this component has no record of ever issuing. Revoking anything
  // here would let anyone sign anyone else out by presenting a made-up string,
  // so an unknown token reports no session and changes nothing.
  if (spent === null) return { session: null, isValid: false };

  const session = await ctx.db.get("sessions", spent.sessionId);
  // Already signed out, expired, or revoked a moment ago by a sibling
  // detecting the same replay. Nothing left to revoke or report.
  if (session === null) return { session: null, isValid: false };

  const now = Date.now();
  if (now - spent._creationTime > REFRESH_GRACE_MS) {
    // Outside of the grace window, invalid.
    return { session, isValid: false };
  }
  if (session.refreshTokenExpiresAt <= now) {
    return { session, isValid: false };
  }
  return { session, isValid: true };
}

/**
 * Rotate a refresh token and mint a fresh access token.
 *
 * Returns `null` when the session can't be refreshed.
 *
 * That can happen with an unknown token, one past its refresh-token lifetime,
 * or a previously used token past the grace refresh window.
 *
 * A dead session is a normal outcome the caller should handle by updating its
 * authenticated state.
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
    // Resolve the TTL config well before use below - it does some validation
    // of the config that will throw if invalid, and that should be
    // unconditional.
    const ttl = resolveTtlConfig(args);

    const hash = await sha256Hex(args.refreshToken);
    let { session, isValid } = await sessionByHash(ctx, hash);
    if (session === null) {
      // This is not the current refresh token - it might still be valid for refresh though.
      ({ session, isValid } = await sessionBySpentHash(ctx, hash));
    }
    if (session === null) return null;
    if (!isValid) {
      // Past its refresh-token lifetime or a spent token past the grace
      // window: delete the session and grant no more tokens.
      console.warn(
        "Spent refresh token used out of grace window: deleting the associated session. " +
          "This could be due to a bug or a leaked refresh token.",
      );
      await deleteSession(ctx, session._id);
      return null;
    }

    const now = Date.now();
    return await rotateSession(ctx, session, now, args.issuer, ttl);
  },
});

/** Revoke a session (sign out). Idempotent. */
export const signOut = mutation({
  args: { refreshToken: v.string() },
  returns: v.null(),
  handler: async (ctx, args) => {
    const hash = await sha256Hex(args.refreshToken);
    const { session } = await sessionByHash(ctx, hash);
    if (session !== null) {
      await deleteSession(ctx, session._id);
      return null;
    }
    // Signing out with a token a refresh rotated away — a tab that signs out
    // just after a sibling refreshed — is a real sign-out request, not a race
    // to resolve, so revoke regardless of the grace window. Matching only the
    // current hash would leave the session alive after a sign-out.
    const spent = await spentTokenByHash(ctx, hash);
    if (spent !== null) await deleteSession(ctx, spent.sessionId);
    return null;
  },
});
