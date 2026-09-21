import {
  actionGeneric,
  createFunctionHandle,
  GenericActionCtx,
  GenericDataModel,
  GenericMutationCtx,
  GenericQueryCtx,
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
  type TokenBundle,
  vRefreshResult,
  type RefreshResult,
  vContinueSignInResult,
  type ContinueSignInResult,
  type SignInCheck,
  type ConvexAuthCtx,
  type UserCallbacks,
  type SignInAttempt,
} from "../../lib/types.ts";

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
   * Refreshes a session using the given token, rotating the refresh token when
   * the presented one is current.
   *
   * Resolves to one of the {@link RefreshResult} outcomes. `rotated` carries a
   * new token bundle to persist. `reused` means a concurrent caller had already
   * rotated this token within its grace window: take the access token and keep
   * the refresh token already in storage, since the winner's response carries
   * the replacement. A `noSession` result should be treated as signed-out.
   */
  refreshSession: RegisteredMutation<
    "public",
    { refreshToken: string },
    Promise<RefreshResult>
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
   * Continues a sign-in that a provider parked on a requirement, once the
   * client has satisfied it.
   *
   * Takes the `attemptToken` of an `incomplete` sign-in result. The core runs
   * the checks the provider named when it parked the sign-in and, when none
   * reports anything outstanding, mints the session and runs the app's
   * `onSignIn`. Resolves to the shared sign-in envelope: `complete` with the
   * tokens, `incomplete` with what is still outstanding (the client continues
   * again once it is met), or the `SIGN_IN_EXPIRED` error when the attempt is
   * gone and the user starts the sign-in over.
   *
   * Apps re-export it like `signOut`, and hand it to `useContinueSignIn` on
   * the client. Under SSR it goes through the auth proxy like any sign-in
   * function, so it belongs in the proxy's `signIn` allowlist.
   */
  continueSignIn: RegisteredMutation<
    "public",
    { attemptToken: string },
    Promise<ContinueSignInResult>
  >;
  /**
   * Resolve an attempt token to the subject of the pending sign-in it names,
   * or `null` when the token is unknown or the attempt has expired.
   *
   * For the functions that satisfy a requirement (a TOTP recipe's code check,
   * say), which verify the factor against the `userId` resolved here and
   * record the proof under `attemptId`, never against an identity the caller
   * supplies. Not meant to be called by application code.
   */
  getPendingSignIn(
    ctx: Pick<GenericQueryCtx<GenericDataModel>, "runQuery">,
    attemptToken: string,
  ): Promise<SignInAttempt | null>;
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
   * Provider setup functions call this from inside their `attachUserCallbacks`,
   * once the app has supplied the callbacks, so the builders can close over
   * them and a provider with no way to create users cannot exist. It is not
   * meant to be called by application code directly.
   */
  bindProvider<Provider extends string, Profile>(
    options: {
      name: Provider;
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
 * when the account already exists. A provider with a requirement to enforce
 * first (a second factor, say) calls `deferSignIn` instead, naming the checks
 * that judge it; the app's `continueSignIn` (returned here) finishes such a
 * sign-in once the client has satisfied them.
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
  /**
   * How long a sign-in that is waiting on a requirement (a second factor,
   * say) stays continuable, in seconds. Defaults to 10 minutes. Past it the
   * user starts the sign-in over.
   */
  attemptTtlSeconds?: number;
}): AuthCore<UsersTable> {
  const {
    component,
    accessTokenTtlSeconds,
    refreshTokenTtlSeconds,
    attemptTtlSeconds,
  } = options;
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
    returns: vRefreshResult,
    handler: async (ctx, args): Promise<RefreshResult> => {
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

  // Runs at the app level so anyone holding an attempt token can reach it,
  // which is fine: the component judges the requirements itself, from the
  // checks the provider pinned to the attempt, and takes nobody's word.
  const continueSignIn = mutationGeneric({
    args: { attemptToken: v.string() },
    returns: vContinueSignInResult,
    handler: async (ctx, { attemptToken }): Promise<ContinueSignInResult> => {
      const result = await ctx.runMutation(
        component.public.completePendingSignIn,
        {
          attemptToken,
          issuer: issuer(),
          accessTokenTtlSeconds,
          refreshTokenTtlSeconds,
        },
      );
      if (result === null) {
        return { status: "error", userError: { error: "SIGN_IN_EXPIRED" } };
      }
      return result;
    },
  });

  const getPendingSignIn = async (
    ctx: Pick<GenericQueryCtx<GenericDataModel>, "runQuery">,
    attemptToken: string,
  ): Promise<SignInAttempt | null> => {
    return await ctx.runQuery(component.public.getPendingSignIn, {
      attemptToken,
    });
  };

  // Names of providers bound to this core, for duplicate detection. Scoped to
  // this `setupCore` call (not module-global): the collision that matters is
  // two providers on the same core, whose accounts would silently share rows.
  const boundProviderNames = new Set<string>();

  const bindProvider = <Provider extends string, Profile>({
    name,
    createUser,
    onSignIn,
  }: {
    name: Provider;
  } & UserCallbacks<
    Provider,
    Profile,
    UsersTable
  >): ProviderBuilders<Profile> => {
    if (boundProviderNames.has(name)) {
      throw new Error(
        `A provider named "${name}" is already bound to this auth core. ` +
          `Provider names key the accounts table, so each provider must ` +
          `have a unique name.`,
      );
    }
    boundProviderNames.add(name);

    // Undefined when the app attached no `onSignIn`, which tells the core to
    // mint the session without notifying the app.
    const onSignInHandle = async (): Promise<string | undefined> =>
      onSignIn === undefined ? undefined : await createFunctionHandle(onSignIn);

    // The provider's sign-in checks, as the core stores them on a pending
    // sign-in: the requirement's name next to a handle to its check. Component
    // functions can be handles too, which is what lets a requirement component
    // (TOTP, say) own its own check.
    const storedChecks = async (
      checks: SignInCheck[],
    ): Promise<{ requirement: string; handle: string }[]> =>
      await Promise.all(
        checks.map(async ({ requirement, check }) => ({
          requirement,
          handle: await createFunctionHandle(check),
        })),
      );

    // The helpers close over the live ctx; both mutation and action ctxs
    // expose the compatible `runMutation`/`runQuery` these need.
    const makeHelpers = (
      ctx:
        | GenericActionCtx<GenericDataModel>
        | GenericMutationCtx<GenericDataModel>,
    ) => ({
      completeSignUp: async (args: {
        providerAccountId: string;
        profile: Profile;
      }): Promise<TokenBundle> => {
        return await ctx.runMutation(component.public.signUp, {
          claims: {
            providerName: name,
            providerAccountId: args.providerAccountId,
            profile: args.profile,
          },
          createUserHandle: await createFunctionHandle(createUser),
          onSignInHandle: await onSignInHandle(),
          issuer: issuer(),
          accessTokenTtlSeconds,
          refreshTokenTtlSeconds,
        });
      },
      createAccount: async (args: {
        providerAccountId: string;
        profile: Profile;
      }): Promise<{ userId: string }> => {
        return await ctx.runMutation(component.public.createAccount, {
          claims: {
            providerName: name,
            providerAccountId: args.providerAccountId,
            profile: args.profile,
          },
          createUserHandle: await createFunctionHandle(createUser),
        });
      },
      completeSignIn: async (args: {
        providerAccountId: string;
        profile: Profile;
      }): Promise<TokenBundle> => {
        return await ctx.runMutation(component.public.signIn, {
          claims: {
            providerName: name,
            providerAccountId: args.providerAccountId,
            profile: args.profile,
          },
          onSignInHandle: await onSignInHandle(),
          issuer: issuer(),
          accessTokenTtlSeconds,
          refreshTokenTtlSeconds,
        });
      },
      resolveUserId: async (
        providerAccountId: string,
      ): Promise<string | null> => {
        return await ctx.runQuery(component.public.getUserIdByAccount, {
          provider: name,
          providerAccountId,
        });
      },
      // The helper of a sign-in that waits on a requirement: park it. The
      // core's `continueSignIn` finishes it, so there is no completion helper
      // here: the row carries the provider's checks and the app's `onSignIn`
      // as function handles. A first sign-in is parked the same way, after
      // `createAccount` above has established the account.
      deferSignIn: async (args: {
        providerAccountId: string;
        profile: Profile;
        checks: SignInCheck[];
      }) => {
        return await ctx.runMutation(component.public.deferSignIn, {
          claims: {
            providerName: name,
            providerAccountId: args.providerAccountId,
            profile: args.profile,
          },
          checks: await storedChecks(args.checks),
          onSignInHandle: await onSignInHandle(),
          attemptTtlSeconds,
        });
      },
    });

    const authMutation: AuthMutationBuilder<Profile> = (fn) =>
      mutationGeneric({
        args: fn.args as PropertyValidators,
        returns: fn.returns,
        handler: (ctx, args) =>
          fn.handler(
            { ...ctx, convexAuth: makeHelpers(ctx) },
            args as Parameters<typeof fn.handler>[1],
          ),
      });

    const authAction: AuthActionBuilder<Profile> = (fn) =>
      actionGeneric({
        args: fn.args as PropertyValidators,
        returns: fn.returns,
        handler: (ctx, args) =>
          fn.handler(
            { ...ctx, convexAuth: makeHelpers(ctx) },
            args as Parameters<typeof fn.handler>[1],
          ),
      });

    return { authMutation, authAction };
  };

  return {
    usersTable,
    signOut,
    refreshSession,
    isAuthenticated,
    continueSignIn,
    getPendingSignIn,
    bindProvider,
  };
}
