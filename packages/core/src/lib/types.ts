import {
  FunctionReference,
  GenericActionCtx,
  GenericDataModel,
} from "convex/server";

import { GenericId, Infer, v } from "convex/values";

/**
 * Shared contracts that cross the core/app boundary. That includes validators (and
 * their inferred types) for what the core's session functions accept and return
 * and any function references. Each is declared once here and reused wherever the
 * core or the app needs it, so the shapes can never drift between declaration sites.
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
  /** Stable, provider-scoped account identifier (e.g. a username). */
  providerAccountId: v.string(),
  /** Arbitrary profile data the provider learned about the user. */
  profile: v.any(),
});

export type AuthClaims = Infer<typeof vAuthClaims>;

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

export type CompleteSignInFunc = (
  ctx: RunMutationCtx,
  claims: AuthClaims,
) => Promise<TokenBundle>;

type ProviderSetupFunc<O, P> = (
  completeSignIn: CompleteSignInFunc,
  options: O,
) => P;

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
   * It will be passed a `completeSignIn` function, which is provided
   * by Convex Auth. That function accepts claims from a provider,
   * establishes a session and returns the tokens required for a client
   * application to make authenticated calls to Convex functions.
   *
   * The provider function that completes an authentication flow should
   * call this function when it has authenticated an account and return
   * the result.
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
 *     setup: (completeSignIn, options: {limit: number}) => {
 *       return {
 *         login: actionGeneric({
 *           args: {},
 *           handler: async (ctx, args) => {
 *             // Do your login magic here.
 *             const claims = await authenticateFoo(args, options.limit);
 *             return completeSignIn(claims);
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
