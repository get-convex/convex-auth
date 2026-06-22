import {
  mutationGeneric,
  createFunctionHandle,
  type FunctionReference,
  type GenericActionCtx,
  type GenericMutationCtx,
} from "convex/server";
import { v } from "convex/values";
import type { ComponentApi } from "./_generated/component.js";
import {
  vTokenBundle,
  type TokenBundle,
  type AccountResolution,
  type AccountLink,
} from "../../lib/tokens.js";
import type { AuthClaims } from "../../lib/claims.js";

/**
 * The shape of the app's user-persistence callback. The app passes
 * `internal.users.upsertFromAuth` (or equivalent) as `createOrUpdateUser`;
 * typing it here gives a compile error if that mutation's args/return drift from
 * what the core expects. The app keeps ownership of its users table — the core
 * only holds a reference to this one mutation.
 *
 * It serves every auth path: sign-in calls it with no `userId` the first time
 * an identity is seen (create the user, return the id) and with the resolved
 * `userId` on every later sign-in (update the user from the latest profile);
 * `linkToCurrentUser` calls it with the already-known `userId` (sync the
 * provider profile onto that user). Apps that don't need to react to the update
 * paths can simply ignore `userId`.
 */
export type CreateOrUpdateUserFn = FunctionReference<
  "mutation",
  "internal",
  {
    provider: string;
    providerAccountId: string;
    profile: Record<string, unknown>;
    userId?: string;
  },
  string
>;

/**
 * Build the app-facing auth-core handlers from the mounted `core` component
 * reference and the app's user create-or-update callback. Returns ready-to-export
 * `signOut`/`refreshSession` mutations plus `completeSignIn`, which the provider
 * factories use to turn provider claims into a session.
 *
 * The core never triggers a sign-in itself: it has no idea how any given
 * provider authenticates a user. *Triggering `signIn` is each provider's
 * responsibility*: a provider verifies the user its own way (checking a
 * password, say), produces the standard claims, and then calls `completeSignIn`
 * to exchange them for a session. The core only supplies that exchange.
 *
 * Token lifetimes are configurable here and default to 1m (access) and 30d
 * (refresh). The access-token TTL must be shorter than the refresh-token TTL,
 * and (since the client refreshes shortly before expiry) comfortably longer
 * than a few seconds.
 */
export function setupCore(opts: {
  component: ComponentApi;
  createOrUpdateUser: CreateOrUpdateUserFn;
  /** Access-token lifetime in seconds. Defaults to 60 (1 minute). */
  accessTokenTtlSeconds?: number;
  /** Refresh-token lifetime in seconds. Defaults to 30 days. */
  refreshTokenTtlSeconds?: number;
}) {
  const {
    component,
    createOrUpdateUser,
    accessTokenTtlSeconds,
    refreshTokenTtlSeconds,
  } = opts;

  const issuer = (): string => {
    const url = process.env.CONVEX_SITE_URL;
    if (!url) throw new Error("CONVEX_SITE_URL is not available");
    return url;
  };

  // --- Provider building blocks --------------------------------------------
  //
  // `completeSignIn`, `completeAuthenticate`, and `linkAccount` are plain
  // helper functions, not registered queries/mutations, because they aren't
  // endpoints a client calls directly. They're composed *inside* a provider's
  // own action or mutation: the provider authenticates the user its own way,
  // then calls one of these (passing its own `ctx`) to talk to the core. They
  // take `ctx` and use `ctx.runQuery`/`ctx.runMutation` precisely so they can
  // run within whatever provider function is already executing.
  //
  // The functions further down (`linkToCurrentUser`, `refreshSession`,
  // `signOut`) are different: they have no provider-specific precondition, so
  // they're registered mutations the app re-exports for the client to call.

  /**
   * Hand a provider's identity claims to the core, passing a handle to the
   * app's user create-or-update mutation so the core can persist app users
   * without knowing the app's schema. A provider calls this from its sign-in
   * action once it has authenticated the user and produced claims.
   *
   * This initiates a session and the returned token bundle allows authenticating
   * with the Convex backend and refreshing the session.
   */
  const completeSignIn = async (
    ctx: GenericActionCtx<any>,
    claims: AuthClaims,
  ): Promise<TokenBundle> => {
    const createOrUpdateUserHandle =
      await createFunctionHandle(createOrUpdateUser);
    return await ctx.runMutation(component.public.signIn, {
      claims,
      createOrUpdateUserHandle,
      issuer: issuer(),
      accessTokenTtlSeconds,
      refreshTokenTtlSeconds,
    });
  };

  /**
   * Resolve a provider's claims against the core *without* minting a session,
   * reporting whether the identity already maps to an app user.
   *
   * This is useful for authentication flows that shouldn't result in a new
   * session.
   */
  const completeAuthenticate = async (
    ctx: GenericActionCtx<any>,
    claims: AuthClaims,
  ): Promise<AccountResolution> => {
    return await ctx.runQuery(component.public.authenticate, { claims });
  };

  /**
   * Low-level linking primitive: attach a verified provider identity to an
   * existing user without minting a session. The core owns the accounts table,
   * so linking must go through here. Most apps don't call this directly. Instead they
   * use the ready-made `linkToCurrentUser` mutation below. Reach for this only
   * when writing a fully custom `authenticate` callback that conditionally links
   * accounts.
   */
  const linkAccount = async (
    ctx: GenericMutationCtx<any>,
    claims: AuthClaims,
    userId: string,
  ): Promise<AccountLink> => {
    return await ctx.runMutation(component.public.linkAccount, {
      claims,
      userId,
    });
  };

  /**
   * Ready-made handler for linking a verified identity onto the *currently
   * signed-in* user. An app exports this directly as the mutation it calls once
   * a provider has verified an additional identity for the signed-in user.
   *
   * It runs on the authenticated client, so `getUserIdentity()` is the active
   * user (e.g. a guest user attaching a durable identity). The core rejects
   * linking an identity that already belongs to a different user. The app's
   * `createOrUpdateUser` callback is reused to sync the provider profile onto
   * the user.
   */
  const linkToCurrentUser = mutationGeneric({
    args: {
      provider: v.string(),
      providerAccountId: v.string(),
      profile: v.any(),
      // Accepted for callers that pass through the result of `authenticate`;
      // the core enforces the conflict, so we only accept the field here rather
      // than act on it.
      existingUserId: v.optional(v.string()),
    },
    returns: v.null(),
    handler: async (ctx, args): Promise<null> => {
      const identity = await ctx.auth.getUserIdentity();
      if (!identity) {
        throw new Error("Must be signed in to link an account.");
      }
      const userId = identity.subject;
      const claims: AuthClaims = {
        provider: args.provider,
        providerAccountId: args.providerAccountId,
        profile: args.profile,
      };
      await linkAccount(ctx, claims, userId);
      await ctx.runMutation(createOrUpdateUser, { ...claims, userId });
      return null;
    },
  });

  /**
   * Refreshes a session using the given token, rotating the refresh token.
   *
   * A successful refresh returns a new token bundle. A failed refresh (an
   * unknown or expired token) returns `null` and leaves no usable session
   * behind (an expired session is deleted as part of the same call). Callers,
   * including the client, should treat a `null` result as signed-out and clear
   * any stored session.
   */
  const refreshSession = mutationGeneric({
    args: { refreshToken: v.string() },
    returns: v.union(vTokenBundle, v.null()),
    handler: async (ctx, args): Promise<TokenBundle | null> => {
      return await ctx.runMutation(component.public.refresh, {
        refreshToken: args.refreshToken,
        issuer: issuer(),
        accessTokenTtlSeconds,
        refreshTokenTtlSeconds,
      });
    },
  });

  /**
   * Signs out of the current session.
   *
   * After this the refresh token is no longer valid.
   */
  const signOut = mutationGeneric({
    args: { refreshToken: v.string() },
    returns: v.null(),
    handler: async (ctx, args) => {
      await ctx.runMutation(component.public.signOut, {
        refreshToken: args.refreshToken,
      });
      return null;
    },
  });

  return {
    completeSignIn,
    completeAuthenticate,
    linkAccount,
    linkToCurrentUser,
    refreshSession,
    signOut,
  };
}
