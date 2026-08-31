import { Infer, v, type Validator } from "convex/values";
import type { RegisteredMutation } from "convex/server";
import {
  vAttemptExpiredError,
  vSignInSuccess,
  USE_USER_ID_AS_ACCOUNT_ID,
  type ProviderSignInOutcome,
  type SignInError,
  type SignInIncomplete,
  type SignInSuccess,
  type UserCallbacks,
} from "../../lib/types.ts";
import {
  requirementValidators,
  type RequirementOf,
  type SignInFactsOf,
  type SignInRequirements,
} from "../../lib/requirements.ts";
import type { AuthCore } from "../core/setup.ts";
import type { ComponentApi } from "./_generated/component.ts";
import type { ComponentApi as UsernameComponentApi } from "../username/_generated/component.ts";
import {
  setUsernameUserError,
  validateUsernameFormat,
} from "../username/validation.ts";
import {
  validateNewPassword,
  setPasswordUserError,
  verifyPasswordUserError,
} from "./validation.ts";

// TODO: derive this from the component mount path rather than hardcoding it.
const PROVIDER_NAME = "password";

/** The profile shape this provider sends to the app's user callbacks. */
type PasswordProfile = { username: string };

/**
 * Options for {@link setupUsernamePassword}.
 */
export type UsernamePasswordOptions<
  R extends SignInRequirements | undefined = undefined,
> = {
  /**
   * The mounted password component (`components.authPasswordProvider`). The
   * recipe drives its `setPassword` / `verifyPassword` mutations.
   */
  component: ComponentApi;
  /**
   * The mounted username component (`components.authUsername`). The recipe
   * uses it to map a username onto the app user id: it stores the username
   * at sign-up and reads it back at sign-in.
   */
  usernameComponent: UsernameComponentApi;
  /**
   * The app's sign-in requirements for this provider: an array of
   * `requirement(...)` declarations (see `@convex-dev/auth/lib/requirements`).
   *
   * Registering requirements switches the provider into evaluating mode: the
   * `onSignIn` callback becomes required, runs as the sign-in *evaluator* on
   * every round, and may leave a sign-in `incomplete`. The sign-in and
   * sign-up results gain an incomplete arm carrying the outstanding
   * requirements and an `attemptToken`, and the setup exports an additional
   * `continueSignInWithPassword` mutation that resumes a parked sign-in once
   * requirements have been satisfied.
   */
  signInRequirements?: R;
};

/** This provider's correctable-failure vocabularies. */
const signInUserError = v.union(
  verifyPasswordUserError,
  v.object({ error: v.literal("USER_NOT_FOUND") }),
);
const signUpUserError = v.union(setPasswordUserError, setUsernameUserError);

type SignInUserError = Infer<typeof signInUserError>;
type SignUpUserError = Infer<typeof signUpUserError>;

/**
 * The incomplete arm of this provider's results, present only when sign-in
 * requirements were registered — so an app that registered none never has to
 * narrow an arm that cannot occur. `R` closes the requirement `kind` union.
 */
type Incomplete<R extends SignInRequirements | undefined> =
  R extends SignInRequirements ? SignInIncomplete<RequirementOf<R>> : never;

/**
 * The result of `signInWithPassword`.
 *
 * On success the minted session tokens, otherwise a user-facing `userError`.
 * When the provider registered sign-in requirements (`R`), the union gains
 * the incomplete arm: the credentials verified but requirements are
 * outstanding, and the sign-in is continued via `continueSignInWithPassword`.
 */
export type SignInResult<R extends SignInRequirements | undefined = undefined> =
  SignInSuccess | Incomplete<R> | SignInError<SignInUserError>;

/**
 * The result of `signUpWithPassword`.
 *
 * On success the minted session tokens, otherwise a user-facing `userError`.
 * When the provider registered sign-in requirements (`R`), the union gains
 * the incomplete arm — the account was created (signing in later re-prompts
 * for what is still outstanding), but no session exists yet.
 */
export type SignUpResult<R extends SignInRequirements | undefined = undefined> =
  SignInSuccess | Incomplete<R> | SignInError<SignUpUserError>;

/**
 * The result of `continueSignInWithPassword`: the sign-in completed, is
 * still incomplete, or the attempt is gone (`ATTEMPT_EXPIRED` — unknown
 * token, lapsed TTL, or exhausted continuation budget) and the user should
 * sign in again from scratch.
 */
export type ContinueSignInWithPasswordResult<R extends SignInRequirements> =
  | SignInSuccess
  | Incomplete<R>
  | SignInError<Infer<typeof vAttemptExpiredError>>;

/**
 * The app user id an outcome refers to, whether or not a session was created.
 * The user exists either way — creation is eager, and only the session is
 * withheld — so the credentials are stored on both arms.
 */
function outcomeUserId(outcome: ProviderSignInOutcome): string {
  return outcome.status === "session-created"
    ? outcome.tokens.userId
    : outcome.userId;
}

/**
 * Convert a core outcome into the arms returned to clients: `session-created`
 * becomes the success arm, `pending-requirements` the incomplete arm with the
 * server-only `userId` stripped. Built field by field rather than forwarded,
 * since only the differing `status` values keep the outcome from satisfying
 * the client arm structurally.
 */
function clientResult(
  outcome: ProviderSignInOutcome,
): SignInSuccess | SignInIncomplete {
  return outcome.status === "session-created"
    ? { status: "complete", tokens: outcome.tokens }
    : {
        status: "incomplete",
        requirements: outcome.requirements,
        attemptToken: outcome.attemptToken,
        expiresAt: outcome.expiresAt,
      };
}

/**
 * The user callbacks this provider's `attachUserCallbacks` takes, typed from
 * the registered requirement specs: with none registered the facts bag and
 * the requirement union are the open ones, and `onSignIn` is the plain
 * per-sign-in hook it has always been.
 */
export type PasswordUserCallbacks<
  UsersTable extends string,
  R extends SignInRequirements | undefined,
> = UserCallbacks<
  "password",
  PasswordProfile,
  UsersTable,
  SignInFactsOf<R>,
  RequirementOf<R>
>;

/**
 * The public functions {@link setupUsernamePassword} produces for the app to
 * export, declared as explicit `RegisteredMutation` aliases so Convex's api
 * codegen preserves the precise arg/result types — including the closed
 * requirement union — all the way into the browser's `api` types.
 * `continueSignInWithPassword` exists (at runtime and in the type) only when
 * sign-in requirements were registered.
 */
export type PasswordApi<R extends SignInRequirements | undefined = undefined> =
  {
    signUpWithPassword: RegisteredMutation<
      "public",
      { username: string; password: string },
      Promise<SignUpResult<R>>
    >;
    signInWithPassword: RegisteredMutation<
      "public",
      { username: string; password: string },
      Promise<SignInResult<R>>
    >;
  } & (R extends SignInRequirements
    ? {
        continueSignInWithPassword: RegisteredMutation<
          "public",
          { attemptToken: string },
          Promise<ContinueSignInWithPasswordResult<R>>
        >;
      }
    : Record<never, never>);

/**
 * The simplest password recipe: every account is a `(username, password)` pair,
 * with no email or email verification. Wire it up in `convex/auth.ts`:
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
 * The app re-exports the returned `signUpWithPassword` / `signInWithPassword`
 * mutations so its clients can call them.
 *
 * To gate sign-ins behind additional requirements (a second factor, a
 * CAPTCHA, …), register them via `signInRequirements` and attach an
 * evaluating `onSignIn`:
 *
 * ```ts
 * export const {
 *   signUpWithPassword,
 *   signInWithPassword,
 *   continueSignInWithPassword,
 * } = setupUsernamePassword(core, {
 *   component: components.authPasswordProvider,
 *   usernameComponent: components.authUsername,
 *   signInRequirements: [mathFactor.requirement],
 * }).attachUserCallbacks({
 *   createUser: internal.users.createUser,
 *   onSignIn: internal.users.evaluateSignIn,
 * });
 * ```
 *
 * The compile-time check on the evaluating `onSignIn` is covariant-only: it
 * catches a callback emitting an undeclared requirement kind or payload,
 * while a callback that *misses* a declared kind is caught at runtime by the
 * validators derived from the same specs.
 *
 * Account resolution (username → app user id) is owned by the username
 * component: the recipe stores the username there at sign-up, and reads the
 * user id back from it at sign-in. The password component itself stores only
 * `{ userId, passwordHash }` and knows nothing about usernames.
 */
export function setupUsernamePassword<
  UsersTable extends string,
  const R extends SignInRequirements | undefined = undefined,
>(core: AuthCore<UsersTable>, options: UsernamePasswordOptions<R>) {
  const { component, usernameComponent, signInRequirements } = options;

  return {
    /**
     * Supply the app's user callbacks (see {@link PasswordUserCallbacks} for
     * how their args must be declared) and get this provider's functions to
     * export.
     */
    attachUserCallbacks(
      callbacks: PasswordUserCallbacks<UsersTable, R>,
    ): PasswordApi<R> {
      const { createUser, onSignIn } = callbacks as UserCallbacks<
        "password",
        PasswordProfile,
        UsersTable
      >;
      const { authMutation } = core.bindProvider({
        name: PROVIDER_NAME,
        createUser,
        onSignIn,
        requirements: signInRequirements,
      });
      // The validator helper's conditional arms only resolve for a
      // non-generic type, and `R` is still a type parameter here. The runtime
      // arms are exact either way — the incomplete arm is built only when
      // requirements were registered — and the closed requirement union
      // reaches clients through `PasswordApi<R>` below.
      const requirements: SignInRequirements | undefined = signInRequirements;

      // The arms every result of this provider shares. The incomplete arm is
      // present only when requirements were registered, and is deferred to
      // `requirementValidators` so the union it carries is the one the app's
      // `onSignIn` is validated against, and so that function's duplicate-kind
      // and duplicate-fact-field checks run on this path too.
      const sharedArms: Validator<unknown, "required", string>[] =
        requirements === undefined
          ? [vSignInSuccess]
          : [
              vSignInSuccess,
              v.object({
                status: v.literal("incomplete"),
                requirements: v.array(
                  requirementValidators(requirements).vRequirement,
                ),
                attemptToken: v.string(),
                expiresAt: v.number(),
              }),
            ];

      /**
       * One result union, at the width the handlers work in: the requirement
       * *kinds* stay open here — the closed union is applied once, at
       * {@link PasswordApi} — but are enforced at runtime by `sharedArms`.
       */
      const resultOf = <UserError>(
        userError: Validator<UserError, "required", string>,
      ) =>
        v.union(
          ...sharedArms,
          v.object({ status: v.literal("error"), userError }),
        ) as unknown as Validator<
          SignInSuccess | SignInIncomplete | SignInError<UserError>,
          "required",
          string
        >;

      const api = {
        /**
         * Create a new account: reject a taken username or an invalid
         * password, otherwise create the user, store the credentials, and
         * either mint the session or report the outstanding requirements.
         *
         * The credentials are stored on an incomplete outcome too: the user
         * and account exist (creation is eager; only the session is
         * withheld), and an abandoned sign-up heals by signing *in* — the
         * evaluator re-runs and re-prompts for what is still outstanding.
         */
        signUpWithPassword: authMutation({
          args: { username: v.string(), password: v.string() },
          returns: resultOf(signUpUserError),
          handler: async (
            ctx,
            { username, password },
          ): Promise<
            SignInSuccess | SignInIncomplete | SignInError<SignUpUserError>
          > => {
            // Validate the username and the password *before* creating
            // anything, so invalid input never mints a user.
            // (`setUsername` and `setPassword` do the same checks again, but by
            // then the account would already exist.)
            // TODO(nicolas) Make the first-party providers apply stronger validation rules by default
            const usernameError = validateUsernameFormat(username);
            if (usernameError !== null) {
              return { status: "error", userError: usernameError };
            }
            const userError = validateNewPassword(password);
            if (userError !== null) {
              return { status: "error", userError };
            }

            const existing = await ctx.runQuery(
              usernameComponent.public.getUserIdByUsername,
              { username },
            );
            if (existing !== null) {
              return {
                status: "error",
                userError: { error: "USERNAME_TAKEN" },
              };
            }

            const outcome = await ctx.convexAuth.completeSignUp({
              providerAccountId: USE_USER_ID_AS_ACCOUNT_ID,
              profile: { username },
            });
            // The credentials are stored on the incomplete arm too: the
            // account exists either way (creation is eager; only the session
            // is withheld) and must be able to finish this sign-in and make
            // later ones.
            const userId = outcomeUserId(outcome);

            const setUsernameResult = await ctx.runMutation(
              usernameComponent.public.setUsername,
              { userId, username },
            );
            if (!setUsernameResult.success) {
              // Unexpected: we validated the username above, and this handler
              // is a mutation, thus the check for a conflict above and this
              // call are in the same transaction.
              // Throwing so that the transaction doesn’t commit.
              throw new Error(
                "Unexpected error when setting the username: " +
                  setUsernameResult.userError.error,
                { cause: setUsernameResult.userError },
              );
            }

            const setResult = await ctx.runMutation(
              component.public.setPassword,
              {
                userId,
                password,
              },
            );
            if (!setResult.success) {
              // Unexpected: we pre-validated the password above,
              // so this call should not fail.
              // Throwing so that the transaction doesn’t commit.
              //
              // TODO(nicolas) can we improve this?
              throw new Error(
                "Unexpected error when setting the password: " + userError,
                { cause: userError },
              );
            }

            return clientResult(outcome);
          },
        }),

        /**
         * Verify an existing account's password and, on success, either mint
         * a session or report the outstanding requirements.
         */
        signInWithPassword: authMutation({
          args: { username: v.string(), password: v.string() },
          returns: resultOf(signInUserError),
          handler: async (
            ctx,
            { username, password },
          ): Promise<
            SignInSuccess | SignInIncomplete | SignInError<SignInUserError>
          > => {
            const userId = await ctx.runQuery(
              usernameComponent.public.getUserIdByUsername,
              { username },
            );
            if (userId === null) {
              return {
                status: "error",
                userError: { error: "USER_NOT_FOUND" },
              };
            }

            const verifyResult = await ctx.runMutation(
              component.public.verifyPassword,
              { userId, password },
            );
            if (!verifyResult.success) {
              return { status: "error", userError: verifyResult.userError };
            }

            // The username resolved to a user id and its password verified, so
            // the account exists and `completeSignIn` (which throws otherwise)
            // is the right helper.
            const outcome = await ctx.convexAuth.completeSignIn({
              providerAccountId: userId,
              profile: { username },
            });
            return clientResult(outcome);
          },
        }),

        /**
         * Resume a parked sign-in once requirements have been satisfied
         * (verification endpoints have recorded their facts): re-evaluate
         * and either mint the session or report what is still outstanding.
         *
         * The password is *not* re-verified here — the attempt token
         * (random, stored hashed, short-lived, and budgeted) is the
         * continuation credential. `ATTEMPT_EXPIRED` means the attempt is
         * gone and the user should sign in from scratch.
         *
         * Spread in only when requirements were registered, matching what
         * {@link PasswordApi} declares. Without them no sign-in is ever
         * parked, so an always-`ATTEMPT_EXPIRED` public mutation would be
         * surface with nothing behind it.
         */
        ...(requirements === undefined
          ? undefined
          : {
              continueSignInWithPassword: authMutation({
                args: { attemptToken: v.string() },
                returns: resultOf(vAttemptExpiredError),
                handler: async (ctx, { attemptToken }) => {
                  const outcome = await ctx.convexAuth.continueSignIn({
                    attemptToken,
                  });
                  if (outcome.status === "expired") {
                    // The one user-correctable condition the core raises
                    // rather than this provider: every other `userError` is
                    // raised before the core is asked for a session.
                    return {
                      status: "error" as const,
                      userError: { error: "ATTEMPT_EXPIRED" as const },
                    };
                  }
                  return clientResult(outcome);
                },
              }),
            }),
      };
      return api as unknown as PasswordApi<R>;
    },
  };
}
