import {
  mutationGeneric,
  queryGeneric,
  createFunctionHandle,
  RegisteredMutation,
  RegisteredQuery,
} from "convex/server";
import { v } from "convex/values";
import type { ComponentApi } from "./_generated/component";
import {
  vTokenBundle,
  type TokenBundle,
  ProviderConfig,
  CompleteSignInFunc,
  ResolveUserIdFunc,
  CreateOrUpdateUserFn,
} from "../../lib/types";

// Helper: pairs a `ProviderConfig` with its options, preserving `Name`, `Options` and `Api` individually.
// TODO: dowski - consider whether this function should exist, or whether defineProvider
// should return a function that's callable with the options.
export function provider<Name extends string, Options, Api>(
  config: ProviderConfig<Name, Options, Api>,
  options: Options,
): readonly [ProviderConfig<Name, Options, Api>, Options] {
  return [config, options] as const;
}

// An explicitly loosely typed tuple of [ProviderConfig, Options]. The `any`s are
// intentional: this is a constraint that concrete provider tuples must extend, and
// `unknown` would break assignability via contravariance in `ProviderConfig.setup`.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type ProviderWithOptions = readonly [ProviderConfig<any, any, any>, any];

// Maps a tuple of entries to
// { [ProviderConfig.name]: ReturnType<ProviderConfig.setup> } by distributing
// over the tuple's union.
type ProviderApis<T extends readonly ProviderWithOptions[]> = {
  [K in T[number] as K[0]["name"]]: ReturnType<K[0]["setup"]>;
};

// The app-facing handlers that `attachUserCallback` produces once the
// create-or-update-user callback is supplied.
type AuthApi<T extends readonly ProviderWithOptions[]> = {
  /**
   * Signs out of the current session.
   *
   * After this the refresh token is no longer valid.
   */
  signOut: RegisteredMutation<
    "public",
    { refreshToken: string },
    Promise<null>
  >;
  /**
   * Refreshes a session using the given token, rotating the refresh token.
   *
   * A successful refresh returns a new token bundle. A failed refresh (an
   * unknown or expired token) returns `null` and leaves no usable session
   * behind (an expired session is deleted as part of the same call). Callers,
   * including the client, should treat a `null` result as signed-out and clear
   * any stored session.
   */
  refreshSession: RegisteredMutation<
    "public",
    { refreshToken: string },
    Promise<TokenBundle | null>
  >;
  /**
   * Reports whether the caller's access token identifies a signed-in user.
   *
   * Convex verifies the token's signature (against the deployment's JWKS)
   * before this query runs, so the result is a trustworthy authentication
   * verdict. SSR hosts call it with the token from the auth cookie to decide
   * authentication state, rather than trusting the (client-controlled) cookie
   * by merely decoding it.
   */
  isAuthenticated: RegisteredQuery<
    "public",
    Record<string, never>,
    Promise<boolean>
  >;
  /**
   * The auth APIs that each provider exposes.
   *
   * Each provider is accessible on this object by its name.
   */
  // TODO: dowski - rather than a nested object of providers, see about
  // folding their APIs in as peers to `signOut` and `refreshSession` for
  // a cleaner developer experience.
  providers: ProviderApis<T>;
};

// Intermediate builder returned by `setupCore` before the app's user callback
// is known. Its sole method, `attachUserCallback`, is deliberately
// *non-generic* in the provider tuple `T`: `T` is already fixed by the time
// `attachUserCallback` is called, so its return type `AuthApi<T>` is fully
// determined without typing the `createOrUpdateUser` argument. See the note
// on `setupCore` for why that decoupling is required.
type CoreBuilder<T extends readonly ProviderWithOptions[]> = {
  /**
   * The `createOrUpdateUser` function passed in here represents the core
   * entrypoint for an application to integrate its user model with Convex Auth.
   *
   * It will be called in two scenarios, both associated with a user signing in:
   *
   *  1. The first time a user signs in with an account from a provider.
   *    * The `userId` argument will not be present in this case.
   *    * The application should do one of:
   *      a. Create a new user record and return its `_id`
   *      b. Use trusted information in the `profile` (e.g. a verified email)
   *         to associate the account with an existing user, and return its
   *         `_id`
   *  2. Subsequent sign ins from a provider
   *    * The `userId` argument will be present.
   *    * The application may use the data in `profile` to update or otherwise
   *      modify the stored user record.
   *    * The existing `userId` must be the return value.
   *
   * The application keeps ownership of its users table — the core only holds a
   * reference to this one mutation.
   *
   * If an application wants to reject a sign in, it can throw a `ConvexError`
   * and the entire sign in attempt will be blocked.
   */
  attachUserCallback(
    createOrUpdateUser: CreateOrUpdateUserFn<T[number][0]["name"]>,
  ): AuthApi<T>;
};

/**
 * Build the app-facing auth-core handlers from the mounted `core` component
 * reference and the auth providers that the app will use. Returns
 * ready-to-export `signOut`/`refreshSession` mutations plus a typesafe
 * `providers` object keyed by provider name and containing its API.
 *
 * The core never triggers a sign-in itself: it has no idea how any given
 * provider authenticates a user. *Triggering `signIn` is each provider's
 * responsibility* and should be part of its returned API. A provider verifies
 * the user its own way (checking a password, say), produces the standard
 * claims, and then calls a `completeSignIn` function that the core makes
 * available to each provider to allow them to exchange claims for a session.
 *
 * Token lifetimes are configurable here and default to 1m (access) and 30d
 * (refresh). The access-token TTL must be shorter than the refresh-token TTL,
 * and (since the client refreshes shortly before expiry) comfortably longer
 * than a few seconds.
 *
 * Changes to token TTLs impact newly minted tokens, not ones that have
 * already been issued.
 *
 * @returns a builder object with an `attachUserCallback` function that
 *          completes the configuration of Convex Auth.
 */
// Why this is a two-step (`setupCore(...).attachUserCallback(...)`) API
//
// The app's `createOrUpdateUser` is a reference into the app's *own* `internal`
// API. But the module that calls `setupCore` also exports the handlers this
// returns (`signOut` etc.), so those exports are part of that same `internal`
// API. If the `internal.*` reference were passed straight into this generic
// call, TS would have to type it while inferring the provider tuple `T` — and
// typing it forces resolving the module's own API type, which depends on these
// exports, which depend on this call: a cycle, reported as
// `TS7022: '…' implicitly has type 'any' because it … is referenced … in its
// own initializer`.
//
// Splitting the call sidesteps that. `setupCore` is generic in `T` but never
// sees the `internal.*` reference, so inferring `T` touches nothing circular.
// `attachUserCallback` *does* take the reference, but by then `T` is fixed,
// so it is a non-generic call whose return type `AuthApi<T>` is fully
// determined by the signature alone. TS resolves the exported bindings' types
// from that return type without eagerly typing the `internal.*` argument, so
// the cycle never forms. (Inside the *single generic* call it did, because
// inferring `T` required typing every argument, `internal.*` included.)
export function setupCore<T extends readonly ProviderWithOptions[]>({
  component,
  accessTokenTtlSeconds,
  refreshTokenTtlSeconds,
  providers,
}: {
  component: ComponentApi;
  /**
   * Access-token lifetime in seconds. Defaults to 60 (1 minute).
   *
   * Changes to this value impact newly minted tokens, not ones that have
   * already been issued.
   */
  accessTokenTtlSeconds?: number;
  /**
   * Refresh-token lifetime in seconds. Defaults to 30 days.
   *
   * Changes to this value impact newly minted tokens, not ones that have
   * already been issued.
   */
  refreshTokenTtlSeconds?: number;
  /**
   * A list of providers with options to configure them.
   *
   * Each one will be wired up to the core and produce an API that will be
   * accessible on {@link AuthApi.providers} which is returned from
   * {@link CoreBuilder.attachUserCallback}.
   *
   * Adding a provider and exporting the Convex API it defines will allow
   * signing in via that provider. The core will create sessions
   * when sign ins happen via the provider. Removing a provider does not
   * revoke those sessions, but will prevent future sign ins.
   */
  providers: T;
}): CoreBuilder<T> {
  const issuer = (): string => {
    const url = process.env.CONVEX_SITE_URL;
    if (!url) throw new Error("CONVEX_SITE_URL is not available");
    return url;
  };

  // Takes the `createOrUpdateUser` callback, wires it to sign in and returns the
  // full auth API.
  const buildFullApi = (
    createOrUpdateUser: CreateOrUpdateUserFn<T[number][0]["name"]>,
  ): AuthApi<T> => {
    const completeSignIn: CompleteSignInFunc = async (ctx, claims) => {
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

    const result: Record<string, unknown> = {};
    for (const [config, options] of providers) {
      const resolveUserId: ResolveUserIdFunc = (ctx, providerAccountId) =>
        ctx.runQuery(component.public.getUserIdByAccount, {
          provider: config.name,
          providerAccountId,
        });
      result[config.name] = config.setup(
        { completeSignIn, resolveUserId },
        options,
      );
    }

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

    // Runs at the app deployment level (not inside the component) because only
    // there does `ctx.auth` reflect the caller's verified identity: Convex
    // checks the access token's signature against the deployment JWKS before
    // the handler runs, so a forged/unsigned token yields no identity here.
    const isAuthenticated = queryGeneric({
      args: {},
      returns: v.boolean(),
      handler: async (ctx): Promise<boolean> => {
        return (await ctx.auth.getUserIdentity()) !== null;
      },
    });

    return {
      refreshSession,
      signOut,
      isAuthenticated,
      providers: result as ProviderApis<T>,
    };
  };

  return { attachUserCallback: buildFullApi };
}
