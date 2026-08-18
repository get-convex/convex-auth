import { FunctionReference } from "convex/server";

import { GenericId, Infer, v } from "convex/values";

/**
 * Shared contracts that cross a module boundary within Convex Auth. That includes
 * validators (and their inferred types) for what the core's session functions
 * accept and return, any function references, and the wire shapes an SSR host's
 * auth routes exchange with the browser. Each is declared once here and reused
 * wherever the core, the app, the server handlers or the client needs it, so the
 * shapes can never drift between declaration sites.
 *
 * This module deliberately depends on nothing else in the package, which is what
 * lets both the server and the browser halves import from it without either
 * reaching into the other's tree.
 */

/**
 * The session a successful sign-in (or refresh) mints: a short-lived access
 * token plus the rotating refresh token, with their expiries and the app user
 * id the access token is minted for.
 */
export const vTokenBundle = v.object({
  accessToken: v.string(),
  accessTokenExpiresAt: v.number(),
  refreshToken: v.string(),
  refreshTokenExpiresAt: v.number(),
  userId: v.string(),
});

export type TokenBundle = Infer<typeof vTokenBundle>;

/**
 * The success arm of every provider's sign-in result.
 *
 * Providers compose this into their result union rather than declaring the
 * success arm themselves. Fixing where the minted bundle sits is what lets the
 * SSR auth proxy find the refresh token without knowing which provider produced
 * the response, and lets it reject a shape it doesn't recognize instead of
 * forwarding tokens to the browser.
 */
export const vSignInSuccess = v.object({
  success: v.literal(true),
  tokens: vTokenBundle,
});

export type SignInSuccess = Infer<typeof vSignInSuccess>;

/**
 * The token bundle that an SSR route hands back to the client. It is a slimmed
 * down version of a {@link TokenBundle} with the refresh token (and its
 * expiry) removed: under SSR the refresh token lives only in an httpOnly
 * cookie and never reaches client JS.
 */
export type SlimTokenBundle = {
  accessToken: string;
  accessTokenExpiresAt: number;
  userId: string;
};

/**
 * Strip down a {@link TokenBundle} down to a {@link SlimTokenBundle},
 * dropping the refresh token so it is never sent to the browser.
 */
export function makeSlimBundle(bundle: TokenBundle): SlimTokenBundle {
  return {
    accessToken: bundle.accessToken,
    accessTokenExpiresAt: bundle.accessTokenExpiresAt,
    userId: bundle.userId,
  };
}

/**
 * The JSON body of every SSR auth session response: the refresh handler, the
 * sign-out handler, and the cross-site refusal all reply with this shape, and
 * the client parses it without looking at the status. `tokens` is null whenever
 * there is no live session to report (a dead or missing refresh cookie, a
 * completed sign-out, a refused origin).
 */
export type AuthSessionResponse = {
  tokens: SlimTokenBundle | null;
};

/**
 * A provider result as clients see it, with the token bundle narrowed to what
 * every session model delivers.
 *
 * Under SSR the auth proxy strips the refresh token before the response reaches
 * the browser, so the slim bundle is all the two models have in common.
 * Declaring that here makes the stripping a widening of the value rather than a
 * broken contract: a {@link TokenBundle} is assignable to a
 * {@link SlimTokenBundle}, so one type stays true for both.
 *
 * It also stops callers depending on the refresh token. Handing the bundle to
 * `setSession` is the only supported use; an app that needs the raw token can
 * call its Convex function with the generated reference and get the full type.
 *
 * Distributes over a result union, leaving failure arms untouched.
 */
export type ClientView<T> = T extends { tokens: TokenBundle }
  ? Omit<T, "tokens"> & { tokens: SlimTokenBundle }
  : T;

/** The app's `refreshSession` mutation reference: exchange a refresh token for a
 * fresh {@link TokenBundle}, or `null` when the session is gone. */
export type RefreshSessionFn = FunctionReference<
  "mutation",
  "public",
  { refreshToken: string },
  TokenBundle | null
>;

/** The app's `signOut` mutation reference: revoke the session for a refresh
 * token. */
export type SignOutFn = FunctionReference<
  "mutation",
  "public",
  { refreshToken: string },
  null
>;

/**
 * The app's `isAuthenticated` query reference: reports whether the access token
 * the query is called with identifies a signed-in user.
 */
export type IsAuthenticatedFn = FunctionReference<
  "query",
  "public",
  Record<string, never>,
  boolean
>;

/**
 * The auth mutations the app exports from `setupCore`.
 * Passed as references (not names) because an app may re-export them under any
 * names. Consumed by both SPA and SSR implementations.
 */
export type ConvexAuthApi = {
  refreshSession: RefreshSessionFn;
  signOut: SignOutFn;
};

/**
 * Shared identity-claims contract between the *provider* components that
 * authenticate users and the *core* component.
 *
 * After a provider authenticates a user it produces this plain payload; the app
 * forwards it to the core's `signIn`, which turns it into a session. Providers
 * never call the core directly, they only know how to produce these claims.
 */
export const vAuthClaims = v.object({
  /** Provider name, e.g. "password". */
  provider: v.string(),
  /**
   * Stable, provider-scoped account identifier (e.g. the Google account ID).
   */
  providerAccountId: v.string(),
  /** Arbitrary profile data the provider learned about the user. */
  profile: v.any(),
});

export type AuthClaims = Infer<typeof vAuthClaims>;

/**
 * The `providerAccountId` a provider sends to `completeSignUp` when it has no
 * identifier of its own. The core then keys the new account by the app user id
 * `createUser` returns, and later sign-ins send that user id as the account
 * identifier.
 *
 * @TODO(nicolas) Consider replacing this mechanism
 */
export const USE_USER_ID_AS_ACCOUNT_ID = "";

export const vCreateUser = v.object({
  provider: v.string(),
  providerAccountId: v.string(),
  profile: v.any(),
});

export const vOnSignIn = v.object({
  provider: v.string(),
  providerAccountId: v.string(),
  profile: v.any(),
  userId: v.string(),
});

/**
 * The args the core calls a `createUser` callback with.
 *
 * The provider's name arrives as a literal, and `profile` is whatever that
 * provider produces, so a callback declaring exactly this shape serves exactly
 * one provider.
 */
export type CreateUserArgs<Provider extends string, Profile> = {
  provider: Provider;
  providerAccountId: string;
  profile: Profile;
};

/**
 * The args the core calls an `onSignIn` callback with: {@link CreateUserArgs}
 * plus the app user id the account resolved to.
 */
export type OnSignInArgs<
  Provider extends string,
  Profile,
  UsersTable extends string = string,
> = {
  provider: Provider;
  providerAccountId: string;
  profile: Profile;
  userId: GenericId<UsersTable>;
};

/**
 * The type of an app defined user-creating mutation: create the app's user
 * record for an identity the core has not seen before, and return its id. It
 * runs once per account, and {@link OnSignInFn} runs right after it, so this
 * one is only responsible for what is true at creation time.
 *
 * This is the core entrypoint for an application to integrate its user model
 * with Convex Auth. Apps install one per provider, via that provider's
 * `attachUserCallbacks`. Throw a `ConvexError` to reject the sign up.
 *
 * The application keeps ownership of its users table. The core treats the
 * returned id as an opaque string at runtime; at the type level the table is
 * named by `setupCore`'s `usersTable` option, which is what makes the return
 * type `Id<usersTable>` rather than a bare string.
 *
 * This type describes the *narrowest* callback a provider accepts: one
 * declaring that provider's exact literal name and profile shape (e.g.
 * `provider: v.literal("password")`, `profile: v.object({ username:
 * v.string() })`). A callback may declare more than that and still be
 * accepted — see {@link AcceptsCreateUserArgs} for what a provider really
 * demands, and for how one mutation can serve several providers.
 */
export type CreateUserFn<
  Provider extends string,
  Profile,
  UsersTable extends string = string,
> = FunctionReference<
  "mutation",
  "internal",
  CreateUserArgs<Provider, Profile>,
  GenericId<UsersTable>
>;

/**
 * The type of an app defined sign-in mutation: an optional hook that runs on
 * *every* sign-in.
 *
 * That includes the first one, where it runs immediately after
 * {@link CreateUserFn} has minted the user. So per-sign-in work (a last-seen
 * timestamp, an audit row, syncing the user record from the latest `profile`,
 * which the core does not store) belongs here and nowhere else.
 *
 * The core resolves the account to its app user first, so `userId` is always
 * present and there is nothing to return. Declare `returns: v.null()` and
 * return `null`, or leave the callback out entirely. Throw a `ConvexError` to
 * reject the sign in, which on a first sign-in rolls back the user the create
 * callback just made.
 *
 * Like {@link CreateUserFn}, this is the narrowest shape a provider accepts;
 * a callback declaring a wider one works too.
 */
export type OnSignInFn<
  Provider extends string,
  Profile,
  UsersTable extends string = string,
> = FunctionReference<
  "mutation",
  "internal",
  OnSignInArgs<Provider, Profile, UsersTable>,
  null
>;

/**
 * Any internal mutation reference, whatever args it declares and whatever it
 * returns.
 *
 * This is the *constraint* on the app's user callbacks, not the check. A
 * provider infers the app's exact reference type against this and then checks
 * it structurally with {@link AcceptsCreateUserArgs} /
 * {@link AcceptsOnSignInArgs}, which is what lets one callback serve several
 * providers (see {@link UserCallbacksFor}).
 */
export type AnyUserCallback = FunctionReference<
  "mutation",
  "internal",
  any,
  any
>;

/**
 * Assert that the callback `F` accepts (at least) the args `Needed`, and
 * returns something the core can use as `Wanted`.
 *
 * Resolves to `unknown` when compatible, so intersecting it with `F` leaves `F`
 * untouched; otherwise it resolves to an object of error fields that no
 * function reference has, so the assignment fails and the message spells out
 * what the callback would have had to declare.
 *
 * The args are checked in the "accepts at least" direction
 * (`Needed extends Declared`) rather than by comparing the two
 * `FunctionReference`s, because a `FunctionReference`'s args compare
 * *covariantly*: `CreateUserFn<"password" | "github", ...>` is not assignable
 * to `CreateUserFn<"password", ...>` even though calling it with password args
 * is perfectly safe. Checking the args directly instead is what lets a single
 * app mutation, declaring a union of provider names and profile shapes (or a
 * `v.any()` profile), be attached to several providers at once. Both sides are
 * wrapped in tuples so a union in `Needed` is checked as a whole rather than
 * distributed over.
 *
 * The keys are then checked in the opposite direction, because the args check
 * alone would pass a callback that *omits* one: a type with fewer properties is
 * still extended by one with more. Convex rejects an arg a mutation never
 * declared, so an omission is a runtime validator error, not a harmless
 * mismatch. Requiring the callback's keys to cover the ones the core sends is
 * what catches it, while still leaving room for extra *optional* args of the
 * app's own (an extra required one fails the args check above, as it should).
 *
 * The return is checked in the ordinary direction: whatever the callback
 * declares must be usable as `Wanted`.
 */
type CallbackCompatible<F extends AnyUserCallback, Needed, Wanted> = [
  Needed,
] extends [F["_args"]]
  ? [keyof Needed] extends [keyof F["_args"]]
    ? [F["_returnType"]] extends [Wanted]
      ? unknown
      : {
          ERROR: "This callback does not return what the provider needs";
          expectedToReturn: Wanted;
          butDeclares: F["_returnType"];
        }
    : {
        ERROR: "This callback does not declare all the args the provider sends";
        expectedToAccept: Needed;
        butDeclares: F["_args"];
      }
  : {
      ERROR: "This callback does not accept the args the provider calls it with";
      expectedToAccept: Needed;
      butDeclares: F["_args"];
    };

/**
 * Assert that `F` is a usable `createUser` for the given provider: it accepts
 * this provider's args and returns an id of the app's users table.
 */
export type AcceptsCreateUserArgs<
  F extends AnyUserCallback,
  Provider extends string,
  Profile,
  UsersTable extends string = string,
> = CallbackCompatible<
  F,
  CreateUserArgs<Provider, Profile>,
  GenericId<UsersTable>
>;

/**
 * Assert that `F` is a usable `onSignIn` for the given provider: it accepts
 * this provider's args (including the app user id) and returns null.
 */
export type AcceptsOnSignInArgs<
  F extends AnyUserCallback,
  Provider extends string,
  Profile,
  UsersTable extends string = string,
> = CallbackCompatible<F, OnSignInArgs<Provider, Profile, UsersTable>, null>;

/**
 * The app's user callbacks for one provider, as its `attachUserCallbacks`
 * takes them: `createUser` is required (something has to create the user
 * record), `onSignIn` is optional.
 *
 * `CreateUser` and `OnSignIn` are the app's *actual* reference types, which
 * each provider's `attachUserCallbacks` infers from what the app passes. They
 * are only required to accept what this provider calls them with, so a
 * callback that declares a union of provider names and profile shapes is
 * accepted by every provider in that union — one mutation, several providers:
 *
 * ```ts
 * export const createUser = internalMutation({
 *   args: {
 *     provider: v.union(v.literal("password"), v.literal("anonymous")),
 *     providerAccountId: v.string(),
 *     profile: v.union(v.object({ username: v.string() }), v.object({})),
 *   },
 *   returns: v.id("users"),
 *   handler: async (ctx, args) => { ... },
 * });
 * ```
 *
 * A callback narrower than the provider needs is rejected, with an error
 * naming the args it would have had to accept.
 */
export type UserCallbacksFor<
  CreateUser extends AnyUserCallback,
  OnSignIn extends AnyUserCallback,
  Provider extends string,
  Profile,
  UsersTable extends string = string,
> = {
  createUser: CreateUser &
    AcceptsCreateUserArgs<CreateUser, Provider, Profile, UsersTable>;
  onSignIn?: OnSignIn &
    AcceptsOnSignInArgs<OnSignIn, Provider, Profile, UsersTable>;
};

/**
 * The app's user callbacks for one provider, in their narrowest form: exactly
 * the shapes {@link CreateUserFn} and {@link OnSignInFn} describe.
 *
 * Provider setup functions take {@link UserCallbacksFor} instead, which also
 * accepts wider callbacks. This remains the shape a provider can *rely* on
 * being callable, and supplies the defaults for those inferred parameters.
 */
export type UserCallbacks<
  Provider extends string,
  Profile,
  UsersTable extends string = string,
> = {
  createUser: CreateUserFn<Provider, Profile, UsersTable>;
  onSignIn?: OnSignInFn<Provider, Profile, UsersTable>;
};

/**
 * The user callbacks as the core receives them from a provider: already
 * checked against that provider by `attachUserCallbacks`, so the core only
 * needs them to be internal mutations it can make handles out of.
 */
export type BoundUserCallbacks = {
  createUser: AnyUserCallback;
  onSignIn?: AnyUserCallback;
};

/**
 * The helpers that `authMutation`/`authAction` inject onto `ctx` for a
 * provider's handlers.
 *
 * This API is used for building auth providers.
 */
export type BoundAuthHelpers<Profile> = {
  /**
   * Exchange a *newly established* account identity for a session.
   *
   * Call this when the provider has just created the account. The core records
   * the account, calls the app's `createUser` to mint the app user, then its
   * `onSignIn` like any other sign-in, and returns the tokens a client needs to
   * make authenticated calls.
   *
   * Throws if the identity already has an account. A provider that cannot tell
   * a first sign-in from a return visit should call
   * {@link BoundAuthHelpers.resolveUserId} first and pick the right helper;
   * both run in one mutation transaction, so the check cannot go stale.
   */
  completeSignUp(args: {
    providerAccountId: string;
    profile: Profile;
  }): Promise<TokenBundle>;
  /**
   * Exchange a verified *existing* account identity for a session.
   *
   * Call this once the provider has authenticated a known account its own way
   * (checking a password, say). The core resolves the account to its app user,
   * runs the app's `onSignIn` callback if one is attached, and returns the
   * tokens a client needs to make authenticated calls.
   *
   * Throws if the identity has no account: reaching this helper is the
   * provider's assertion that the account exists, so a miss is a bug rather
   * than an authentication failure to report to the user.
   */
  completeSignIn(args: {
    providerAccountId: string;
    profile: Profile;
  }): Promise<TokenBundle>;
  /**
   * Look up the app user id for a given `providerAccountId`.
   *
   * Returns `null` when no user id is found for the account.
   */
  resolveUserId(providerAccountId: string): Promise<string | null>;
};

/**
 * The ctx additions that `authMutation`/`authAction` provide to provider
 * handlers.
 *
 * The {@link BoundAuthHelpers} are available under `ctx.convexAuth`.
 */
export type ConvexAuthCtx<Profile> = {
  convexAuth: BoundAuthHelpers<Profile>;
};
