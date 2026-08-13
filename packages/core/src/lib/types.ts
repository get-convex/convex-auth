import {
  FunctionReference,
  GenericActionCtx,
  GenericDataModel,
} from "convex/server";

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
 * The auth mutations the app exports from `setupCore(...).attachUserCallback`.
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

export type CreateOrUpdateUserFn<Provider extends string> = FunctionReference<
  "mutation",
  "internal",
  {
    provider: Provider;
    providerAccountId: string;
    // TODO: dowski - investigate type safety for provider profile data.
    profile: unknown;
    userId: string | null;
  },
  GenericId<"users">
>;

/**
 * The subset of a Convex `ctx` that {@link CompleteSignInFunc} needs. It only
 * calls `runMutation`, so accepting this structural type lets a provider
 * complete sign in from either a mutation or an action.
 */
type RunMutationCtx = Pick<GenericActionCtx<GenericDataModel>, "runMutation">;

/**
 * The subset of a Convex `ctx` that {@link ResolveUserIdFunc} needs. It only
 * calls `runQuery`, so accepting this structural type lets a provider resolve
 * a user id from either a mutation or an action.
 */
type RunQueryCtx = Pick<GenericActionCtx<GenericDataModel>, "runQuery">;

/**
 * Exchanges verified auth claims for a bundle.
 */
export type CompleteSignInFunc = (
  ctx: RunMutationCtx,
  claims: AuthClaims,
) => Promise<TokenBundle>;

/**
 * A function that finds the user ID a provider account ID is associated with
 * (bound to a particular provider).
 *
 * This does not mint a session or edit any data.
 */
export type ResolveUserIdFunc = (
  ctx: RunQueryCtx,
  providerAccountId: string,
) => Promise<string | null>;

export type ProviderHelpers = {
  completeSignIn: CompleteSignInFunc;
  resolveUserId: ResolveUserIdFunc;
};

type ProviderSetupFunc<O, P> = (helpers: ProviderHelpers, options: O) => P;

export type ProviderConfig<N extends string, O, P> = {
  /**
   * The name of this provider.
   *
   * This value will be persisted the `accounts` table and passed to
   * the {@link CreateOrUpdateUserFn}.
   */
  // TODO: consider making the component more first-class in the API and using its name.
  name: N;
  /**
   * Convex Auth will call this function to setup this provider.
   *
   * It should return an object of names to Convex functions that will
   * make up the public API surface of the provider. The provider APIs
   * should be exported by application code so they are callable by
   * client code. The API is responsible for authenticating a user and
   * triggering the completion of sign in.
   *
   * It will be passed a {@link ProviderHelpers} bundle, provided by Convex
   * Auth. `completeSignIn` accepts claims from a provider, establishes a
   * session and returns the tokens required for a client application to make
   * authenticated calls to Convex functions; the provider function that
   * completes an authentication flow should call it once it has authenticated
   * an account and return the result. `resolveUserId` looks up the app user id
   * behind one of this provider's account identifiers without minting a session
   * (e.g. to find the user a password should be verified against).
   *
   * It will also receive any `options` that the provider defined.
   */
  setup: ProviderSetupFunc<O, P>;
};

/**
 * A convenience function for defining a `ProviderConfig`.
 *
 * Call it like:
 *
 * ```typescript
 * const FooProvider = defineProvider(
 *   {
 *     name: "foo",
 *     setup: ({ completeSignIn, resolveUserId }, options: {limit: number}) => {
 *       return {
 *         login: actionGeneric({
 *           args: {},
 *           handler: async (ctx, args) => {
 *             // Do your login magic here.
 *             const claims = await authenticateFoo(args, options.limit);
 *             return completeSignIn(ctx, claims);
 *           }
 *         })
 *       }
 *     },
 *   }
 * );
 * ```
 *
 * All of the generic types are inferred from the passed in object.
 */
export function defineProvider<const N extends string, O, P>(
  config: ProviderConfig<N, O, P>,
): ProviderConfig<N, O, P> {
  return config;
}
