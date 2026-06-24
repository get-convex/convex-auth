import {
  mutationGeneric,
  createFunctionHandle,
  type GenericActionCtx,
} from "convex/server";
import { v } from "convex/values";
import type { ComponentApi } from "./_generated/component.js";
import {
  vTokenBundle,
  type TokenBundle,
  type AuthClaims,
} from "../../lib/types.js";
import { CreateOrUpdateUserFn } from "../../lib/types.js";

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
  // `completeSignIn` is a plain helper function, not a registered
  // query/mutation, because it isn't an endpoint a client calls directly. It's
  // composed *inside* a provider's own action: the provider authenticates the
  // user its own way, then calls it (passing its own `ctx`) to talk to the
  // core. It takes `ctx` and uses `ctx.runMutation` precisely so it can run
  // within whatever provider function is already executing.
  //
  // The functions further down (`refreshSession`, `signOut`) are different:
  // they have no provider-specific precondition, so they're registered
  // mutations the app re-exports for the client to call.

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
    refreshSession,
    signOut,
  };
}
