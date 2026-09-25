import { FunctionReference, FunctionReference_future } from "convex/server";

import { GenericId, Infer, v, type Validator } from "convex/values";

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
 * A complete sign-in result.
 *
 * Providers compose this into their result union rather than declaring the
 * complete arm themselves. Fixing where the minted bundle sits is what lets the
 * SSR auth proxy find the refresh token without knowing which provider produced
 * the response, and lets it reject a shape it doesn't recognize instead of
 * forwarding tokens to the browser.
 */
export const vSignInComplete = v.object({
  status: v.literal("complete"),
  tokens: vTokenBundle,
});

export type SignInComplete = Infer<typeof vSignInComplete>;

/**
 * A sign-in that resulted in an error, carrying that provider's own
 * `userError` codes.
 *
 * The `status` is shared so every arm of every provider is discriminated the
 * same way; the payload is not, because what can go wrong is provider-specific.
 *
 * ```ts
 * const signInResult = v.union(
 *   vSignInComplete,
 *   vSignInError(v.object({ error: v.literal("USER_NOT_FOUND") })),
 * );
 * ```
 */
export function vSignInError<
  UserError extends Validator<unknown, "required", string>,
>(userError: UserError) {
  return v.object({ status: v.literal("error"), userError });
}

/** The inferred shape of a {@link vSignInError} arm. */
export type SignInError<UserError> = {
  status: "error";
  userError: UserError;
};

/**
 * A sign-in attempt that has not met all requirements to grant a session.
 *
 * One or more *requirements* (a second factor, say) stands between the user
 * and a session. Nothing was minted. It's up to the client to satisfy the
 * requirement, then continue sign-in with `attemptToken`.
 *
 * `requirements` names what is outstanding, so the client can show the right
 * step. Each name is the requirement's own (`"totp"` is what the TOTP
 * component calls itself), the same whichever provider held the sign-in, so
 * one client step serves every provider that asks for it.
 *
 * As with `userError`, the `status` is shared and the payload is
 * provider-specific:
 *
 * ```ts
 * const signInResult = v.union(
 *   vSignInComplete,
 *   vSignInIncomplete(v.literal("totp")),
 *   vSignInError(v.object({ error: v.literal("USER_NOT_FOUND") })),
 * );
 * ```
 *
 * The attempt token continues a sign-in that has already proved some
 * credentials (e.g. a first factor), so treat it like a credential: keep it in
 * memory for the duration of the flow, and nowhere else.
 *
 * The client hands it to the function that satisfies the requirement, then to
 * the core's `continueSignIn`, which mints the session once every check the
 * provider named is satisfied. It is spent by that completion and expires at
 * `expiresAt` (a Unix timestamp in milliseconds), after which a sign-in must
 * be started over.
 */
export function vSignInIncomplete<
  Requirement extends Validator<string, "required", never>,
>(requirement: Requirement) {
  return v.object({
    status: v.literal("incomplete"),
    attemptToken: v.string(),
    expiresAt: v.number(),
    requirements: v.array(requirement),
  });
}

/** The shape of a {@link vSignInIncomplete} arm. */
export type SignInIncomplete<Requirement extends string = string> = {
  status: "incomplete";
  attemptToken: string;
  expiresAt: number;
  requirements: Requirement[];
};

/**
 * The full shared sign-in envelope.
 *
 * Represents sign-ins that ran to completion, those that are waiting on a
 * requirement, and those that hit an error.
 *
 * `userError` is `unknown` and the requirement is `string` here because each
 * provider declares its own codes.
 */
export type SignInEnvelope =
  SignInComplete | SignInIncomplete | SignInError<unknown>;

/** The `status` discriminant of every {@link SignInEnvelope}. */
export type SignInStatus = SignInEnvelope["status"];

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
  providerName: v.string(),
  /**
   * Stable, provider-scoped account identifier (e.g. the Google account ID).
   */
  providerAccountId: v.string(),
  /** Arbitrary profile data the provider learned about the user. */
  profile: v.any(),
});

export type AuthClaims = Infer<typeof vAuthClaims>;

/**
 * A pending sign-in attempt as the core reports it to a function that
 * satisfies a requirement: the `userId` whose credentials verified, and the
 * attempt they verified for.
 *
 * `attemptId` identifies the attempt to requirement components. It's up to
 * them to record satsifaction of a requirement for a given attempt with that
 * ID.
 */
export const vSignInAttempt = v.object({
  attemptId: v.string(),
  userId: v.string(),
  expiresAt: v.number(),
});

export type SignInAttempt = Infer<typeof vSignInAttempt>;

/**
 * A query that checks if a requirement has been satsified for a sign-in
 * attempt.
 *
 * A check is a predicate over state its own component owns (has this attempt
 * verified a TOTP code, say). It gets the `userId` and `attemptId` and returns
 * `true` when the requirement it stands for is satisfied. A requirement
 * component exposes one of these, and a component that enforces two things
 * exposes two.
 */
export type CheckSignInFn = FunctionReference<
  "query",
  "public" | "internal",
  { userId: string; attemptId: string },
  boolean
>;

/**
 * A requirement a pending sign-in must satisfy: the check that judges it,
 * and the name it is reported under in an incomplete sign-in result.
 *
 * The requirement component that owns the check names it, and exports the
 * two together (the TOTP component's `totpSignInCheck`, say). A provider
 * passes that on among the `checks` of `deferSignIn` and derives its own
 * `incomplete` result from the same name, so the client sees one name for
 * the step whichever provider held the sign-in, and whether the provider or
 * the core's `continueSignIn` reported it.
 *
 * The core stores the name and a handle to the check on the pending sign-in,
 * so what a sign-in must satisfy is fixed when it is parked, and the core
 * can judge it without the provider when the client continues.
 */
export type SignInCheck<Requirement extends string = string> = {
  requirement: Requirement;
  check: CheckSignInFn;
};

/**
 * The result of the core's `continueSignIn` mutation.
 *
 * `complete` carries the minted session. `incomplete` means at least one
 * check still reports a requirement, listed in `requirements`, and the same
 * attempt token continues the sign-in once it is met. `SIGN_IN_EXPIRED` means
 * the attempt is unknown, expired, superseded, or already completed, and the
 * user starts the sign-in over.
 */
export const vContinueSignInResult = v.union(
  vSignInComplete,
  vSignInIncomplete(v.string()),
  vSignInError(v.object({ error: v.literal("SIGN_IN_EXPIRED") })),
);

export type ContinueSignInResult = Infer<typeof vContinueSignInResult>;

/**
 * The app's `continueSignIn` mutation reference. See
 * {@link vContinueSignInResult} for the outcomes.
 */
export type ContinueSignInFn = FunctionReference<
  "mutation",
  "public",
  { attemptToken: string },
  ContinueSignInResult
>;

/**
 * The `providerAccountId` a provider sends to `completeSignUp` when it has no
 * identifier of its own. The core then keys the new account by the app user id
 * `createUser` returns, and later sign-ins send that user id as the account
 * identifier.
 *
 * @TODO(nicolas) Consider replacing this mechanism
 */
export const USE_USER_ID_AS_ACCOUNT_ID = "";

/**
 * The type of an app defined user-creating mutation: create the app's user
 * record for an identity the core has not seen before, and return its id. It
 * runs once per account, and {@link OnSignInFn} runs right after it, so this
 * one is only responsible for what is true at creation time.
 *
 * This is the core entrypoint for an application to integrate its user model
 * with Convex Auth. Apps install one per provider, although the function that
 * is passed in may be shared across multiple providers if it is typed to
 * accept a union of them.
 *
 * The application keeps ownership of its users table. The core treats the
 * returned id as an opaque string at runtime; at the type level the table is
 * named by `setupCore`'s `usersTable` option, which is what makes the return
 * type `Id<usersTable>` rather than a bare string.
 */
export type CreateUserFn<
  ProviderName extends string,
  Profile,
  UsersTable extends string = string,
> = FunctionReference_future<
  "mutation",
  "internal",
  {
    provider: {
      name: ProviderName;
      accountId: string;
      profile: Profile;
    };
  },
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
 */
export type OnSignInFn<
  ProviderName extends string,
  Profile,
  UsersTable extends string = string,
> = FunctionReference_future<
  "mutation",
  "internal",
  {
    provider: {
      name: ProviderName;
      accountId: string;
      profile: Profile;
    };
    userId: GenericId<UsersTable>;
  },
  null
>;

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
   * Create the account and the app user for a *newly established* identity
   * without signing it in.
   *
   * Call this where {@link BoundAuthHelpers.completeSignUp} would otherwise
   * go when a requirement the provider enforces (an email to verify, say)
   * stands before the first sign-in, and then defer that sign-in with
   * {@link BoundAuthHelpers.deferSignIn}.
   *
   * The user and the account exist from here on. A user who abandons the
   * sign-up and signs in later resolves the same account, and the provider's
   * requirement applies to that sign-in the same way.
   *
   * Returns the app user id.
   */
  createAccount(args: {
    providerAccountId: string;
    profile: Profile;
  }): Promise<{ userId: string }>;
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
  /**
   * Defer the sign-in for a verified *existing* account identity instead of
   * minting a session, because a requirement the provider enforces is still
   * outstanding.
   *
   * Call this where {@link BoundAuthHelpers.completeSignIn} would otherwise
   * go. The core resolves the account, records the pending sign-in with the
   * given `checks` (see {@link SignInCheck}), and hands back the attempt
   * token the client continues with, the `attemptId` that requirement
   * components key their proof by, and the app user id. The app's `onSignIn`
   * does not run: the sign-in has not happened yet.
   *
   * The provider is done at this point. The client satisfies the requirement
   * through the requirement's own functions and then calls the core's
   * `continueSignIn`, which runs the checks and mints the session once every
   * one of them passes.
   *
   * An identity has one pending sign-in at a time. Deferring again replaces
   * it, invalidating the earlier attempt token and id.
   *
   * Throws if the identity has no account, like `completeSignIn` does. To
   * park an identity's *first* sign-in, establish the account with
   * {@link BoundAuthHelpers.createAccount} first.
   */
  deferSignIn(args: {
    providerAccountId: string;
    profile: Profile;
    checks: SignInCheck[];
  }): Promise<{
    attemptToken: string;
    attemptId: string;
    userId: string;
    expiresAt: number;
  }>;
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
