import { DefaultFunctionArgs, FunctionReference } from "convex/server";

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
 * dropping the refresh token so it is never sent to the browser. Also accepts a
 * {@link ReusedSession}, which has no refresh token to drop.
 */
export function makeSlimBundle(
  bundle: TokenBundle | ReusedSession,
): SlimTokenBundle {
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

/**
 * A session whose refresh token a concurrent caller had already rotated:
 * everything a {@link TokenBundle} carries except the refresh token.
 *
 * There cannot be a refresh token here, since the current one is persisted only
 * as a hash. `refreshTokenExpiresAt` is not secret and is carried so a caller
 * storing the access token in a cookie can give it a rotation's lifetime.
 */
export type ReusedSession = Omit<TokenBundle, "refreshToken">;

/**
 * The result of refreshing a session. The `kind` will be one of:
 *
 *  * `rotated`: the presented token was current and has been exchanged for the
 *    bundle in `tokens`. Persist both tokens.
 *  * `reused`: a concurrent caller had already rotated the presented token,
 *    which is still inside its grace window. Take the access token and treat a
 *    previously stored refresh token as current.
 *  * `noSession`: the token is unknown, or was rotated too long ago to honor.
 *    Clear any stored session, treat it as signed out.
 */
export const vRefreshResult = v.union(
  v.object({ kind: v.literal("rotated"), tokens: vTokenBundle }),
  v.object({
    kind: v.literal("reused"),
    accessToken: v.string(),
    accessTokenExpiresAt: v.number(),
    refreshTokenExpiresAt: v.number(),
    userId: v.string(),
  }),
  v.object({ kind: v.literal("noSession") }),
);

export type RefreshResult = Infer<typeof vRefreshResult>;

/** The app's `refreshSession` mutation reference: exchange a refresh token for
 * a fresh session. See {@link vRefreshResult} for the outcomes. */
export type RefreshSessionFn = FunctionReference<
  "mutation",
  "public",
  { refreshToken: string },
  RefreshResult
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
 * A phantom slot (never present at runtime) that reads `convex`'s
 * `_contraArgs` marker on {@link FunctionReference}, putting `Args` in a
 * contravariant position.
 *
 * A bare `FunctionReference` compares its arguments *covariantly*, which is
 * backwards for a callback the library calls rather than the app: a mutation
 * demanding *more* than the core will pass is accepted (and then fails at
 * runtime), while one accepting *broader* arguments — a union of provider
 * names, say — is rejected even though calling it is safe.
 *
 * Intersecting this with a `FunctionReference` reverses both, so a callback is
 * checked the way TypeScript checks an ordinary function parameter. See
 * {@link CallbackFn} for how it is applied, and the `_contraArgs` docs in
 * `convex/server` for why each piece is shaped the way it is.
 *
 * The slot must stay a *property* with an explicit `| undefined`: method
 * syntax is compared bivariantly (checking nothing) and a non-optional
 * `undefined` is rejected under `exactOptionalPropertyTypes`.
 */
export type AcceptsArgs<Args> = {
  _contraArgs?: ((args: Args) => void) | undefined;
};

/**
 * An app-supplied internal mutation the core calls with `Args`, checked
 * contravariantly via {@link AcceptsArgs}.
 *
 * `Args` must be `any` in the `FunctionReference` itself — anything narrower
 * and TypeScript compares the two argument positions covariantly again, losing
 * the property. Intersecting (rather than restating the reference's slots) is
 * what keeps the result assignable back to a plain `FunctionReference`, so the
 * core can still hand these to `createFunctionHandle`.
 *
 * The cost of that `any` is that it also lands in the reference's `_args`
 * slot, so anything read back off this type (`CallbackFn[...]["_args"]`) is
 * unchecked. Nothing should: the core describes the payloads it sends with
 * {@link CreateUserArgs} and {@link OnSignInArgs}, which the callback types
 * are built from, so its own call sites stay checked without reading `_args`.
 */
type CallbackFn<
  Args extends DefaultFunctionArgs,
  ReturnType,
> = FunctionReference<
  "mutation",
  "internal",
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  any,
  ReturnType
> &
  AcceptsArgs<Args>;

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
 * The payload the core sends to a {@link CreateUserFn}.
 *
 * Named separately from the reference type because {@link CallbackFn} puts
 * `any` in the reference's own argument slot (that `any` is what makes the
 * app's callback compare contravariantly). Reading `CreateUserFn["_args"]`
 * therefore yields `any`, so the core's own `runMutation` call sites take this
 * type instead and stay checked. Both are built from this one declaration, so
 * the two cannot drift.
 */
export type CreateUserArgs<Provider extends string, Profile> = {
  provider: Provider;
  providerAccountId: string;
  profile: Profile;
};

/**
 * The type of an app defined user-creating mutation: create the app's user
 * record for an identity the core has not seen before, and return its id. It
 * runs once per account, and {@link OnSignInFn} runs right after it, so this
 * one is only responsible for what is true at creation time.
 *
 * This is the core entrypoint for an application to integrate its user model
 * with Convex Auth. Apps install one per provider, via that provider's
 * `attachUserCallbacks`, typed with that provider's exact name and profile
 * shape. Throw a `ConvexError` to reject the sign up.
 *
 * The application keeps ownership of its users table. The core treats the
 * returned id as an opaque string at runtime; at the type level the table is
 * named by `setupCore`'s `usersTable` option, which is what makes the return
 * type `Id<usersTable>` rather than a bare string.
 *
 * The mutation's args are checked contravariantly (see {@link CallbackFn}), so
 * they must *accept* what the core passes rather than match it exactly. A
 * mutation declaring the provider's own literal types works (`provider:
 * v.literal("password")`, `profile: v.object({ username: v.string() })`), and
 * so does one declared more broadly: a single mutation shared across providers
 * can declare a union of provider names (`v.union(v.literal("password"),
 * v.literal("google"))`) and a profile covering both. What is rejected is a
 * mutation demanding *more* than the core will pass — an extra required arg, or
 * a profile field this provider does not produce — which is exactly the case
 * that would fail at runtime.
 */
export type CreateUserFn<
  Provider extends string,
  Profile,
  UsersTable extends string = string,
> = CallbackFn<CreateUserArgs<Provider, Profile>, GenericId<UsersTable>>;

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
 * Like {@link CreateUserFn}, the args are checked contravariantly, so one
 * mutation declaring a union of provider names can be shared across providers.
 */
/**
 * The payload the core sends to an {@link OnSignInFn}: a
 * {@link CreateUserArgs} plus the resolved app user id. Separate from the
 * reference type for the same reason as {@link CreateUserArgs}.
 */
export type OnSignInArgs<
  Provider extends string,
  Profile,
  UsersTable extends string = string,
> = CreateUserArgs<Provider, Profile> & { userId: GenericId<UsersTable> };

export type OnSignInFn<
  Provider extends string,
  Profile,
  UsersTable extends string = string,
> = CallbackFn<OnSignInArgs<Provider, Profile, UsersTable>, null>;

/**
 * The app's user callbacks for one provider, as its `attachUserCallbacks`
 * takes them: {@link CreateUserFn} is required (something has to create the
 * user record), {@link OnSignInFn} is optional.
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
   * {@link BoundAuthHelpers.resolveUserId} first and pick the right helper.
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
   * Create the account and the app user for a verified identity, but do not
   * mint a session.
   *
   * Call this when the user must complete a step (for example, an email
   * validation) before the first sign-in. Account creation follows the same
   * rules as `completeSignUp`: the app's `createUser` mints the user, and an
   * identity that already has an account is refused. `onSignIn` does not run.
   * The provider signs the user in later with `completeSignIn`.
   */
  signUpWithoutSession(args: {
    providerAccountId: string;
    profile: Profile;
  }): Promise<{ userId: string }>;
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
