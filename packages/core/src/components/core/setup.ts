import {
  actionGeneric,
  createFunctionHandle,
  GenericActionCtx,
  GenericDataModel,
  GenericMutationCtx,
  mutationGeneric,
  queryGeneric,
  RegisteredAction,
  RegisteredMutation,
  RegisteredQuery,
  ReturnValueForOptionalValidator,
} from "convex/server";
import { ObjectType, PropertyValidators, v, Validator } from "convex/values";
import type { ComponentApi } from "./_generated/component.ts";
import {
  vTokenBundle,
  type TokenBundle,
  type ConvexAuthCtx,
  type UserCallbacks,
  type BoundAuthHelpers,
  type ProviderRequirement,
  type ProviderSignInOutcome,
  type ProviderContinueOutcome,
  type AttemptContext,
} from "../../lib/types.ts";
import type { SignInRequirements } from "../../lib/requirements.ts";

// Re-exported so capability modules (a second factor, a verifier) can type a
// `components.auth`-shaped parameter without reaching into `_generated`.
export type { ComponentApi } from "./_generated/component.ts";

/**
 * A type for a factory that returns a `RegisteredMutation` with a handler that
 * has access to provider-bound auth helpers on `ctx.convexAuth`.
 *
 * The signature mirrors convex's own `MutationBuilder` inference, simplified
 * where providers never need the generality: `args` is required (dropping the
 * zero-arg/function shorthand machinery) and there is no app data model
 * (providers are app-agnostic; their storage lives behind their own
 * component's functions). `returns` keeps convex's exact optional-validator
 * scheme: with a validator, the handler's return is constrained to (a promise
 * of) its type; without one, it falls back to whatever the handler declares.
 */
export type AuthMutationBuilder<Profile> = <
  ArgsValidator extends PropertyValidators,
  ReturnsValidator extends
    PropertyValidators | Validator<unknown, "required", string> | void,
  ReturnValue extends ReturnValueForOptionalValidator<ReturnsValidator> =
    ReturnValueForOptionalValidator<ReturnsValidator>,
>(fn: {
  args: ArgsValidator;
  returns?: ReturnsValidator;
  handler: (
    ctx: GenericMutationCtx<GenericDataModel> & ConvexAuthCtx<Profile>,
    args: ObjectType<ArgsValidator>,
  ) => ReturnValue;
}) => RegisteredMutation<"public", ObjectType<ArgsValidator>, ReturnValue>;

/** The action flavor of {@link AuthMutationBuilder}. */
export type AuthActionBuilder<Profile> = <
  ArgsValidator extends PropertyValidators,
  ReturnsValidator extends
    PropertyValidators | Validator<unknown, "required", string> | void,
  ReturnValue extends ReturnValueForOptionalValidator<ReturnsValidator> =
    ReturnValueForOptionalValidator<ReturnsValidator>,
>(fn: {
  args: ArgsValidator;
  returns?: ReturnsValidator;
  handler: (
    ctx: GenericActionCtx<GenericDataModel> & ConvexAuthCtx<Profile>,
    args: ObjectType<ArgsValidator>,
  ) => ReturnValue;
}) => RegisteredAction<"public", ObjectType<ArgsValidator>, ReturnValue>;

/**
 * The function builders a provider gets from {@link AuthCore.bindProvider}.
 *
 * Each builds a public Convex function whose handler receives the
 * provider-bound helpers on `ctx.convexAuth` alongside the standard ctx.
 */
export type ProviderBuilders<Profile> = {
  authMutation: AuthMutationBuilder<Profile>;
  authAction: AuthActionBuilder<Profile>;
};

/**
 * The core auth API returned by {@link setupCore}: the session handlers the
 * app re-exports, plus {@link AuthCore.bindProvider} for wiring up providers.
 */
export type AuthCore<UsersTable extends string = string> = {
  /**
   * The name of the app's users table, as configured on {@link setupCore}.
   *
   * Carried on the value (not just in the type) so provider setup functions
   * can infer `UsersTable` from the `core` they are handed, and so the name is
   * available for error messages.
   */
  usersTable: UsersTable;
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
   * Register a provider with the core and get the function builders its
   * implementation uses.
   *
   * `name` identifies the provider in the core's `accounts` table: accounts
   * are keyed by `(name, providerAccountId)`, so it must be unique among the
   * providers bound to this core — a duplicate throws immediately (two
   * providers sharing a name would silently share accounts).
   *
   * `createUser` is the app's user-creating callback for this provider and
   * `onSignIn` is its optional per-sign-in hook (see {@link UserCallbacks}).
   *
   * `requirements` are the app-registered requirement specs, when the provider
   * setup was given any via its `signInRequirements` option; attaching them
   * without an `onSignIn` to evaluate them throws. `providerRequirements` are
   * requirements the provider itself registers from its own config options,
   * checked by the framework rather than by the app's callback.
   *
   * Provider setup functions call this from inside their `attachUserCallbacks`,
   * once the app has supplied the callbacks, so the builders can close over
   * them and a provider with no way to create users cannot exist. It is not
   * meant to be called by application code directly.
   */
  bindProvider<Provider extends string, Profile>(
    options: {
      name: Provider;
      requirements?: SignInRequirements;
      providerRequirements?: ProviderRequirement[];
    } & UserCallbacks<Provider, Profile, UsersTable>,
  ): ProviderBuilders<Profile>;
};

/**
 * Build the app-facing auth-core handlers from the mounted `core` component
 * reference. Returns ready-to-export `signOut`/`refreshSession`/
 * `isAuthenticated` handlers plus `bindProvider`, which provider setup
 * functions use to wire themselves to the core:
 *
 * ```ts
 * const core = setupCore({ component: components.auth });
 * export const { signOut, refreshSession, isAuthenticated } = core;
 *
 * export const { signUpWithPassword, signInWithPassword } =
 *   setupUsernamePassword(core, {
 *     component: components.authPasswordProvider,
 *     usernameComponent: components.authUsername,
 *   }).attachUserCallbacks({ createUser: internal.users.createUserPassword });
 * ```
 *
 * The core never triggers a sign-in itself: it has no idea how any given
 * provider authenticates a user. *Triggering sign-in is each provider's
 * responsibility.* A provider verifies the user its own way (checking a
 * password, say) and then calls one of the helpers the core injects on
 * `ctx.convexAuth` to exchange the verified identity for a session:
 * `completeSignUp` when it has just established the account, `completeSignIn`
 * when the account already exists.
 *
 * Token lifetimes are configurable here and default to 1m (access) and 30d
 * (refresh). The access-token TTL must be shorter than the refresh-token TTL,
 * and (since the client refreshes shortly before expiry) comfortably longer
 * than a few seconds.
 *
 * Changes to token TTLs impact newly minted tokens, not ones that have
 * already been issued.
 */
export function setupCore<UsersTable extends string = "users">(options: {
  component: ComponentApi;
  /**
   * The name of the app's users table. Defaults to `"users"`.
   *
   * The core never reads or writes the table — it only stores the id the app's
   * `createUser` callback returns. The name is a *type-level* contract: it makes
   * every provider's `attachUserCallbacks` demand a `createUser` returning
   * `Id<usersTable>` and an `onSignIn` taking one, so an app cannot accidentally
   * hand back an id from some other table (and, because the app then declares
   * `v.id(usersTable)`, Convex enforces the same thing at runtime).
   *
   * Set this if the app's users live in a table with a different name:
   *
   * ```ts
   * const core = setupCore({ component: components.auth, usersTable: "members" });
   * ```
   */
  usersTable?: UsersTable;
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
}): AuthCore<UsersTable> {
  const { component, accessTokenTtlSeconds, refreshTokenTtlSeconds } = options;
  // The default only matters to the type system (the core never touches the
  // table), but keep the value in sync with the `= "users"` default above.
  const usersTable = options.usersTable ?? ("users" as UsersTable);

  const issuer = (): string => {
    const url = process.env.CONVEX_SITE_URL;
    if (!url) throw new Error("CONVEX_SITE_URL is not available");
    return url;
  };

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

  // Names of providers bound to this core, for duplicate detection. Scoped to
  // this `setupCore` call (not module-global): the collision that matters is
  // two providers on the same core, whose accounts would silently share rows.
  const boundProviderNames = new Set<string>();

  // Either helper ctx flavor: both mutation and action ctxs expose the
  // compatible `runMutation`/`runQuery` the helpers need.
  type HelperCtx =
    GenericActionCtx<GenericDataModel> | GenericMutationCtx<GenericDataModel>;

  const bindProvider = <Provider extends string, Profile>(
    options: {
      name: Provider;
      requirements?: SignInRequirements;
      providerRequirements?: ProviderRequirement[];
    } & UserCallbacks<Provider, Profile, UsersTable>,
  ): ProviderBuilders<Profile> => {
    const { name, createUser, onSignIn } = options;
    if (boundProviderNames.has(name)) {
      throw new Error(
        `A provider named "${name}" is already bound to this auth core. ` +
          `Provider names key the accounts table, so each provider must ` +
          `have a unique name.`,
      );
    }
    boundProviderNames.add(name);

    if (options.requirements !== undefined && onSignIn === undefined) {
      throw new Error(
        `Provider "${name}" was bound with sign-in requirements but no ` +
          `onSignIn callback; something has to evaluate the requirements.`,
      );
    }

    const onSignInHandle = async (): Promise<string | undefined> =>
      onSignIn === undefined ? undefined : await createFunctionHandle(onSignIn);

    const claimsFor = (args: {
      providerAccountId: string;
      profile: Profile;
    }) => ({
      provider: name,
      providerAccountId: args.providerAccountId,
      profile: args.profile,
    });

    const resolveUserId =
      (ctx: HelperCtx) =>
      async (providerAccountId: string): Promise<string | null> => {
        return await ctx.runQuery(component.public.getUserIdByAccount, {
          provider: name,
          providerAccountId,
        });
      };

    const providerRequirements = options.providerRequirements ?? [];

    const makeHelpers = (ctx: HelperCtx): BoundAuthHelpers<Profile> => ({
      completeSignUp: async (args): Promise<ProviderSignInOutcome> => {
        return await ctx.runMutation(component.public.signUp, {
          claims: claimsFor(args),
          createUserHandle: await createFunctionHandle(createUser),
          onSignInHandle: await onSignInHandle(),
          providerRequirements,
          issuer: issuer(),
          accessTokenTtlSeconds,
          refreshTokenTtlSeconds,
        });
      },
      completeSignIn: async (args): Promise<ProviderSignInOutcome> => {
        return await ctx.runMutation(component.public.signIn, {
          claims: claimsFor(args),
          onSignInHandle: await onSignInHandle(),
          providerRequirements,
          issuer: issuer(),
          accessTokenTtlSeconds,
          refreshTokenTtlSeconds,
        });
      },
      continueSignIn: async (args): Promise<ProviderContinueOutcome> => {
        return await ctx.runMutation(component.public.continueSignIn, {
          attemptToken: args.attemptToken,
          onSignInHandle: await onSignInHandle(),
          providerRequirements,
          issuer: issuer(),
          accessTokenTtlSeconds,
          refreshTokenTtlSeconds,
        });
      },
      resolveUserId: resolveUserId(ctx),
      getAttemptContext: async (
        attemptToken: string,
      ): Promise<AttemptContext | null> => {
        return await ctx.runQuery(component.public.getAttemptContext, {
          attemptToken,
        });
      },
      recordAttemptFacts: async (
        attemptToken: string,
        facts: Record<string, unknown>,
        scope?: "app" | "provider",
      ): Promise<boolean> => {
        return await ctx.runMutation(component.public.recordAttemptFacts, {
          attemptToken,
          facts,
          scope,
        });
      },
      penalizeAttempt: async (attemptToken: string): Promise<boolean> => {
        return await ctx.runMutation(component.public.penalizeAttempt, {
          attemptToken,
        });
      },
    });

    const authMutation = (fn: {
      args: PropertyValidators;
      returns?: Validator<unknown, "required", string> | PropertyValidators;
      handler: (ctx: unknown, args: unknown) => unknown;
    }) =>
      mutationGeneric({
        args: fn.args,
        returns: fn.returns,
        handler: (ctx, args) =>
          fn.handler({ ...ctx, convexAuth: makeHelpers(ctx) }, args),
      });

    const authAction = (fn: {
      args: PropertyValidators;
      returns?: Validator<unknown, "required", string> | PropertyValidators;
      handler: (ctx: unknown, args: unknown) => unknown;
    }) =>
      actionGeneric({
        args: fn.args,
        returns: fn.returns,
        handler: (ctx, args) =>
          fn.handler({ ...ctx, convexAuth: makeHelpers(ctx) }, args),
      });

    return { authMutation, authAction } as ProviderBuilders<Profile>;
  };

  return { usersTable, signOut, refreshSession, isAuthenticated, bindProvider };
}
