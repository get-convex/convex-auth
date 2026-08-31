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
 *
 * @module
 */

import { FunctionReference } from "convex/server";

import { GenericId, Infer, v } from "convex/values";

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
 * One pending sign-in requirement as it crosses the wire: its registered
 * `kind` plus the payload the server sends down with it (a CAPTCHA
 * challenge, a label to display, …).
 *
 * The core treats requirements as opaque payloads of this shape; apps close
 * the vocabulary with `@convex-dev/auth/lib/requirements`, which narrows
 * both ends of the wire to the declared kinds.
 */
export const vSignInRequirement = v.object({
  kind: v.string(),
  data: v.optional(v.any()),
});

export type SignInRequirement = Infer<typeof vSignInRequirement>;

/** The success arm, `complete`: a session was minted. */
export const vSignInSuccess = v.object({
  status: v.literal("complete"),
  tokens: vTokenBundle,
});

export type SignInSuccess = Infer<typeof vSignInSuccess>;

/**
 * The incomplete arm: the credentials verified, but sign-in requirements
 * remain outstanding. `attemptToken` resumes the parked sign-in.
 *
 * The server-side counterpart is {@link ProviderSignInOutcome}'s
 * `pending-requirements` arm, which additionally carries a server-only
 * `userId`. Nothing but the differing `status` values keeps that arm from
 * satisfying this type structurally, so a provider must build this arm from
 * the outcome's fields rather than forwarding it — see the note on
 * `vProviderSignInOutcome`.
 */
export type SignInIncomplete<Req = SignInRequirement> = {
  status: "incomplete";
  requirements: Req[];
  attemptToken: string;
  expiresAt: number;
};

/** The error arm: a correctable, provider-specific failure. */
export type SignInError<UserError> = {
  status: "error";
  userError: UserError;
};

/**
 * The verdict an evaluating `onSignIn` callback returns: `null` accepts the
 * sign-in (a session is minted), `requirements-needed` withholds the session
 * and surfaces the still-outstanding requirements to the client.
 *
 * The value reads as the directive it is — it *asks* the core for the
 * requirements it names. What the core then reports to provider code is
 * {@link ProviderSignInOutcome}'s `pending-requirements` arm.
 */
export type OnSignInVerdict = null | {
  status: "requirements-needed";
  requirements: SignInRequirement[];
};

/**
 * A *provider-registered* requirement, injected by a provider's setup
 * function based on its config options (as opposed to the app-registered
 * requirement specs the `onSignIn` evaluator judges). The framework itself
 * checks it: the requirement is outstanding until every field in
 * `factFields` is present in the attempt's provider-scoped facts bag, which
 * provider-owned verification endpoints populate via
 * `recordAttemptFacts(..., "provider")`. Invisible to the app's `onSignIn`.
 */
export const vProviderRequirement = v.object({
  kind: v.string(),
  data: v.optional(v.any()),
  factFields: v.array(v.string()),
});

export type ProviderRequirement = Infer<typeof vProviderRequirement>;

/**
 * The outcome of a sign-in as the core component reports it to provider
 * code: `session-created` with the minted tokens, or `pending-requirements`
 * with the outstanding requirements and the attempt token that continues it.
 *
 * These values deliberately differ from the `success`/`incomplete` the client
 * arms use ({@link SignInSuccess}, {@link SignInIncomplete}). Both layers
 * discriminate on `status`, so distinct vocabularies are what stop a
 * server-side outcome — which carries the server-only `userId` — from
 * satisfying a client arm structurally and reaching the browser unstripped.
 * They also read as what they are: a statement about the *session*, not about
 * the shape of a reply.
 *
 * The `pending-requirements` arm is always stateful: the sign-in is parked as
 * an attempt row and `attemptToken` is the credential that resumes it (until
 * `expiresAt`). `userId` is server-only — the user exists even though the
 * sign-in is incomplete (user creation is eager; only the session is
 * withheld) — and providers strip it before returning results to clients.
 */
export const vProviderSignInOutcome = v.union(
  v.object({ status: v.literal("session-created"), tokens: vTokenBundle }),
  v.object({
    status: v.literal("pending-requirements"),
    requirements: v.array(vSignInRequirement),
    attemptToken: v.string(),
    expiresAt: v.number(),
    userId: v.string(),
  }),
);

export type ProviderSignInOutcome = Infer<typeof vProviderSignInOutcome>;

/**
 * The outcome of continuing a parked sign-in attempt: the sign-in outcomes
 * plus `expired` for an attempt that is gone — an unknown token, a lapsed
 * TTL, or an exhausted continuation budget, deliberately indistinguishable
 * from one another.
 */
export const vProviderContinueOutcome = v.union(
  ...vProviderSignInOutcome.members,
  v.object({ status: v.literal("expired") }),
);

export type ProviderContinueOutcome = Infer<typeof vProviderContinueOutcome>;

/**
 * The `userError` a provider reports for a continuation whose attempt is gone
 * — the client-facing translation of the `expired` outcome above. It is the
 * one user-correctable condition the core raises rather than the provider, so
 * the vocabulary is declared here with the outcome instead of per provider.
 * The user restarts the sign-in.
 */
export const vAttemptExpiredError = v.object({
  error: v.literal("ATTEMPT_EXPIRED"),
});

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
  // Always sent, and always empty for an app with no sign-in requirements.
  facts: v.any(),
});

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
 * The mutation's args must be declared with the provider's *exact* literal
 * types (e.g. `provider: v.literal("password")`, `profile: v.object({ username:
 * v.string() })`).
 *
 * One mutation shared across providers, declaring a union of provider names,
 * is runtime-safe but does not typecheck, because `FunctionReference` args
 * compare covariantly. For shared logic, define one thin mutation per provider
 * that delegates to a plain shared function.
 */
export type CreateUserFn<
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
  },
  GenericId<UsersTable>
>;

/**
 * The type of an app defined sign-in mutation: an optional hook that runs on
 * *every* sign-in — the first one (right after {@link CreateUserFn} has
 * minted the user) and every one after it, including each continuation of a
 * sign-in that is waiting on requirements.
 *
 * It is the app's sign-in *evaluator*, and it is deliberately blind to which
 * round it is: it judges `(user, profile, facts)` and nothing else. Per
 * sign-in work (a last-seen timestamp, an audit row, syncing the user record
 * from the latest `profile`, which the core does not store) belongs here and
 * nowhere else.
 *
 * Return `null` to accept the sign-in and have a session minted — an app with
 * no sign-in requirements returns `null` unconditionally, so `returns:
 * v.null()` is the whole contract. With requirements registered, return a
 * `requirements-needed` verdict listing what is still outstanding: the session is
 * withheld, but the user and account already exist (creation is eager) and,
 * unlike a throw, the verdict *commits* the callback's writes. Throwing a
 * `ConvexError` remains the hard rejection and, on a first sign-in, rolls
 * back the user the create callback just made.
 *
 * `facts` is the accumulated, server-verified evidence for this sign-in. It
 * is always passed and always empty for an app with no requirements (declare
 * `facts: v.object({})`, or the `vFacts` that
 * `@convex-dev/auth/lib/requirements` derives from the registered specs).
 * `Facts` and `Requirement` derive from those same specs; the compile-time
 * check is covariant-only, catching a callback that *emits* an undeclared
 * kind, while a callback that misses a declared kind is caught at runtime by
 * validators derived from the same specs.
 *
 * `providerAccountId` is always the *resolved* account id, never a provider's
 * internal sign-up placeholder.
 *
 * Like {@link CreateUserFn}, the args must be declared with the provider's
 * exact literal types, and one mutation per provider (delegating to a plain
 * shared function) is how to share logic across providers.
 */
export type OnSignInFn<
  Provider extends string,
  Profile,
  UsersTable extends string = string,
  Facts = Record<string, unknown>,
  Requirement extends SignInRequirement = SignInRequirement,
> = FunctionReference<
  "mutation",
  "internal",
  {
    provider: Provider;
    providerAccountId: string;
    profile: Profile;
    userId: GenericId<UsersTable>;
    facts: Facts;
  },
  null | { status: "requirements-needed"; requirements: Requirement[] }
>;

/**
 * The app's user callbacks for one provider, as its `attachUserCallbacks`
 * takes them: {@link CreateUserFn} is required (something has to create the
 * user record), {@link OnSignInFn} is optional — though a provider that
 * registers sign-in requirements must attach one, since something has to
 * evaluate them.
 */
export type UserCallbacks<
  Provider extends string,
  Profile,
  UsersTable extends string = string,
  Facts = Record<string, unknown>,
  Requirement extends SignInRequirement = SignInRequirement,
> = {
  createUser: CreateUserFn<Provider, Profile, UsersTable>;
  onSignIn?: OnSignInFn<Provider, Profile, UsersTable, Facts, Requirement>;
};

/**
 * The subject of a parked sign-in attempt, as verification endpoints resolve
 * it from an attempt token.
 *
 * Endpoints must verify factors against this subject — never against a
 * caller-supplied identity — so "confirm the factor" cannot become "confirm
 * as anyone".
 */
export const vAttemptContext = v.object({
  provider: v.string(),
  providerAccountId: v.string(),
  userId: v.string(),
});

export type AttemptContext = Infer<typeof vAttemptContext>;

/**
 * The helpers that `authMutation`/`authAction` inject onto `ctx` for a
 * provider's handlers.
 *
 * The sign-in helpers return a {@link ProviderSignInOutcome} rather than a
 * bare bundle: a sign-in is `session-created` when nothing is outstanding,
 * and `pending-requirements` when requirements remain, whether the app
 * registered them or the provider did. A provider with neither only ever sees
 * `session-created`, and narrows to it rather than declaring an arm that
 * cannot occur.
 *
 * These stay loosely typed (open requirement and facts shapes): the precise
 * static types are applied once, at the provider setup's public API.
 *
 * This API is used for building auth providers.
 */
export type BoundAuthHelpers<Profile> = {
  /**
   * Exchange a *newly established* account identity for a session.
   *
   * Call this when the provider has just created the account. The core
   * records the account, calls the app's `createUser` to mint the app user,
   * then runs its `onSignIn` like any other sign-in.
   *
   * Throws if the identity already has an account. A provider that cannot
   * tell a first sign-in from a return visit should call
   * {@link BoundAuthHelpers.resolveUserId} first and pick the right helper.
   */
  completeSignUp(args: {
    providerAccountId: string;
    profile: Profile;
  }): Promise<ProviderSignInOutcome>;
  /**
   * Exchange a verified *existing* account identity for a session.
   *
   * Call this once the provider has authenticated a known account its own way
   * (checking a password, say). The core resolves the account to its app user
   * and runs the app's `onSignIn` callback if one is attached.
   *
   * Throws if the identity has no account: reaching this helper is the
   * provider asserting the account exists.
   */
  completeSignIn(args: {
    providerAccountId: string;
    profile: Profile;
  }): Promise<ProviderSignInOutcome>;
  /**
   * Re-evaluate a parked sign-in attempt, after a verification endpoint has
   * recorded new facts. Completes the sign-in when nothing is outstanding,
   * reports the remaining requirements otherwise, and reports `expired` for
   * an attempt that is gone.
   */
  continueSignIn(args: {
    attemptToken: string;
  }): Promise<ProviderContinueOutcome>;
  /**
   * Look up the app user id for a given `providerAccountId`.
   *
   * Returns `null` when no user id is found for the account.
   */
  resolveUserId(providerAccountId: string): Promise<string | null>;
  /**
   * Resolve the subject of a live attempt from its token, or `null` when the
   * attempt is gone.
   *
   * Step 1 of the recipe for an endpoint that *verifies* a requirement
   * server-side: resolve the subject and verify the factor against it, then
   * {@link BoundAuthHelpers.recordAttemptFacts} on success or
   * {@link BoundAuthHelpers.penalizeAttempt} on failure — without the latter
   * the endpoint is an unmetered guessing oracle.
   */
  getAttemptContext(attemptToken: string): Promise<AttemptContext | null>;
  /**
   * Record server-verified facts on a live attempt (shallow merge). Returns
   * `false` when the attempt is gone. `scope` defaults to `"app"` — facts the
   * app's `onSignIn` sees; `"provider"` facts live in a separate bag only the
   * framework's provider-requirement checks read.
   */
  recordAttemptFacts(
    attemptToken: string,
    facts: Record<string, unknown>,
    scope?: "app" | "provider",
  ): Promise<boolean>;
  /**
   * Burn continuation budget on a live attempt after a *failed*
   * verification. Returns `false` when the attempt is gone.
   */
  penalizeAttempt(attemptToken: string): Promise<boolean>;
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
