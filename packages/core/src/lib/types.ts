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
 * Pass this as `providerAccountId` to `completeSignIn` when the provider has
 * no identifier of its own. The core then keys the new account by the app
 * user id it mints during sign-in. On later sign-ins, pass that user id as
 * the account identifier.
 *
 * @TODO(nicolas) Consider replacing this mechanism
 */
export const USE_USER_ID_AS_ACCOUNT_ID = "";

export const vCreateOrUpdateUser = v.object({
  provider: v.string(),
  providerAccountId: v.string(),
  profile: v.any(),
  userId: v.union(v.string(), v.null()),
});

/**
 * The type of an app defined create-or-update-user mutation.
 *
 * This is the core entrypoint for an application to integrate its user model
 * with Convex Auth. Apps install one per provider, via that provider's
 * `attachUserCallback`, typed with that provider's exact name and profile
 * shape.
 *
 * It will be called in two scenarios, both associated with a user signing in:
 *
 *  1. The first time a user signs in with an account from a provider.
 *    * The `userId` argument will be `null` in this case.
 *    * The application should create a new user record and return its `_id`
 *  2. Subsequent sign ins from a provider
 *    * The `userId` argument will be present.
 *    * The application may use the data in `profile` to update or otherwise
 *      modify the stored user record.
 *    * The existing `userId` must be the return value.
 *
 * The application keeps ownership of its users table — the core only holds a
 * reference to this one mutation, and treats the returned user id as an opaque
 * string at runtime. At the type level the table is named by the `usersTable`
 * option on `setupCore` (defaulting to `"users"`), which is what makes the
 * callback's `userId` argument and return type `Id<usersTable>` rather than a
 * bare string.
 *
 * If an application wants to reject a sign in, it can throw a `ConvexError`
 * and the entire sign in attempt will be blocked.
 *
 * The mutation's args must be declared with the provider's *exact* literal
 * types (e.g. `provider: v.literal("password")`, `profile: v.object({ username:
 * v.string() })`).
 *
 * One mutation shared across providers, declaring a union of provider names,
 * is runtime-safe but does not typecheck, because `FunctionReference` args
 * compare covariantly. For shared logic, define one thin mutation per provider
 * that delegates to a plain shared function.
 */
export type CreateOrUpdateUserFn<
  Provider extends string,
  Profile,
  UsersTable extends string = string,
> = FunctionReference<
  "mutation",
  "internal",
  {
    provider: Provider;
    providerAccountId: string;
    profile: Profile;
    userId: GenericId<UsersTable> | null;
  },
  GenericId<UsersTable>
>;

/**
 * The helpers that `authMutation`/`authAction` inject onto `ctx` for a
 * provider's handlers.
 *
 * This API is used for building auth providers.
 */
export type BoundAuthHelpers<Profile> = {
  /**
   * Exchange a verified account identity for a session.
   *
   * Call this once the provider has authenticated an account its own way
   * (checking a password, say). It resolves (or creates) the account and its
   * app user via an app-provided create-or-update-user callback, mints a
   * session, and returns the tokens a client needs to make authenticated
   * calls.
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
