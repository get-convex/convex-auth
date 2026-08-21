import { Infer, v } from "convex/values";
import {
  vSignInSuccess,
  USE_USER_ID_AS_ACCOUNT_ID,
  type AnyUserCallback,
  type OnSignInFn,
  type UserCallbacksFor,
} from "../../lib/types";
import type { AuthCore } from "../core/setup";
import type { ComponentApi } from "./_generated/component.js";
import type { ComponentApi as UsernameComponentApi } from "../username/_generated/component.js";
import {
  setUsernameUserError,
  validateUsernameFormat,
} from "../username/validation";
import {
  validateNewPassword,
  setPasswordUserError,
  verifyPasswordUserError,
} from "./validation";

// TODO: derive this from the component mount path rather than hardcoding it.
const PROVIDER_NAME = "password";

/** What this provider tells the app about a user: just the username. */
type PasswordProfile = { username: string };

/**
 * Options for {@link setupUsernamePassword}.
 */
export type UsernamePasswordOptions = {
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
};

const signInResult = v.union(
  vSignInSuccess,
  v.object({
    success: v.literal(false),
    userError: v.union(
      verifyPasswordUserError,
      v.object({ error: v.literal("USER_NOT_FOUND") }),
    ),
  }),
);

/**
 * The result of `signInWithPassword`.
 *
 * On success the minted session tokens, otherwise a user-facing `userError`.
 */
export type SignInResult = Infer<typeof signInResult>;

const signUpResult = v.union(
  vSignInSuccess,
  v.object({
    success: v.literal(false),
    userError: v.union(setPasswordUserError, setUsernameUserError),
  }),
);

/**
 * The result of `signUpWithPassword`.
 *
 * On success the minted session tokens, otherwise a user-facing `userError`.
 */
export type SignUpResult = Infer<typeof signUpResult>;

/**
 * The simplest password recipe: every account is a `(username, password)` pair,
 * with no email or email verification. Wire it up in `convex/auth.ts`:
 *
 * ```ts
 * const core = setupCore({ component: components.auth });
 * export const { signOut, refreshSession, isAuthenticated } = core;
 *
 * const password = setupUsernamePassword(core, {
 *   component: components.authPasswordProvider,
 *   usernameComponent: components.authUsername,
 * });
 * password.attachUserCallbacks({ createUser: internal.users.createUserPassword });
 * export const { signUpWithPassword, signInWithPassword } = password.exports;
 * ```
 *
 * The app re-exports the `signUpWithPassword` / `signInWithPassword`
 * mutations so its clients can call them.
 *
 * Account resolution (username → app user id) is owned by the username
 * component: the recipe stores the username there at sign-up, and reads the
 * user id back from it at sign-in. The password component itself stores only
 * `{ userId, passwordHash }` and knows nothing about usernames.
 */
export function setupUsernamePassword<UsersTable extends string>(
  core: AuthCore<UsersTable>,
  options: UsernamePasswordOptions,
) {
  const { component, usernameComponent } = options;

  const attach = (createUser: AnyUserCallback, onSignIn?: AnyUserCallback) => {
    const { authMutation } = core.bindProvider<PasswordProfile>({
      name: PROVIDER_NAME,
      createUser,
      onSignIn,
    });

    return {
        /**
         * Create a new account: reject a taken username or an invalid password,
         * otherwise create the user + session and store the username and the
         * password.
         */
        signUpWithPassword: authMutation({
          args: { username: v.string(), password: v.string() },
          returns: signUpResult,
          handler: async (
            ctx,
            { username, password },
          ): Promise<SignUpResult> => {
            // Validate the username and the password *before* creating
            // anything, so invalid input never mints a session.
            // (`setUsername` and `setPassword` do the same checks again, but by
            // then the account would already exist.)
            // TODO(nicolas) Make the first-party providers apply stronger validation rules by default
            const usernameError = validateUsernameFormat(username);
            if (usernameError !== null) {
              return { success: false, userError: usernameError };
            }
            const userError = validateNewPassword(password);
            if (userError !== null) {
              return { success: false, userError };
            }

            const existing = await ctx.runQuery(
              usernameComponent.public.getUserIdByUsername,
              { username },
            );
            if (existing !== null) {
              return { success: false, userError: { error: "USERNAME_TAKEN" } };
            }

            // Create the account + app user (via the app's createUser) and
            // mint the session. Password accounts are keyed by the app user id,
            // which does not exist before this call mints it, hence the
            // placeholder; sign-in passes the user id itself. `profile.username`
            // keeps the original casing for display.
            //
            // TODO(nicolas) The app's user callbacks should not receive a
            // provider account ID for the password provider at all: the value
            // is an internal key ("" at sign-up, the user id afterwards) with
            // no meaning to the app. We will probably improve this when
            // providers support typesafe profiles.
            const tokens = await ctx.convexAuth.completeSignUp({
              providerAccountId: USE_USER_ID_AS_ACCOUNT_ID,
              profile: { username },
            });

            const setUsernameResult = await ctx.runMutation(
              usernameComponent.public.setUsername,
              { userId: tokens.userId, username },
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
                userId: tokens.userId,
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

            return { success: true, tokens };
          },
        }),

        /**
         * Verify an existing account's password and, on success, mint a session.
         * Returns `USER_NOT_FOUND` when the username has no account and
         * `INVALID_CREDENTIALS` when the password is wrong, so callers can tell
         * the two apart. (Account existence is already observable via sign-up's
         * `USERNAME_TAKEN`, so distinguishing them here leaks nothing new.)
         */
        signInWithPassword: authMutation({
          args: { username: v.string(), password: v.string() },
          returns: signInResult,
          handler: async (
            ctx,
            { username, password },
          ): Promise<SignInResult> => {
            const userId = await ctx.runQuery(
              usernameComponent.public.getUserIdByUsername,
              { username },
            );
            if (userId === null) {
              return {
                success: false,
                userError: { error: "USER_NOT_FOUND" },
              };
            }

            const verifyResult = await ctx.runMutation(
              component.public.verifyPassword,
              { userId, password },
            );
            if (!verifyResult.success) {
              return { success: false, userError: verifyResult.userError };
            }

            // The username resolved to a user id and its password verified, so
            // the account exists and `completeSignIn` (which throws otherwise)
            // is the right helper.
            const tokens = await ctx.convexAuth.completeSignIn({
              providerAccountId: userId,
              profile: { username },
            });
            return { success: true, tokens };
          },
        }),
      };
  };

  let attached: ReturnType<typeof attach> | undefined;

  return {
    /**
     * Supply the app's user callbacks (see {@link UserCallbacksFor} for how
     * their args must be declared). The provider's functions are available on
     * {@link exports} afterwards.
     *
     * Because this call is generic (that is what checks that the callbacks
     * *accept* what this provider sends, so a mutation declaring a union of
     * provider names and profile shapes can be attached here and to other
     * providers as well), its result cannot feed an `export` in the same
     * module that `internal` is generated from — TypeScript would have to
     * type the module's exports in terms of themselves (TS7022). Call it as
     * its own statement and export from `exports`, which is not generic.
     */
    attachUserCallbacks<
      CreateUser extends AnyUserCallback,
      OnSignIn extends AnyUserCallback = OnSignInFn<
        "password",
        PasswordProfile,
        UsersTable
      >,
    >({
      createUser,
      onSignIn,
    }: UserCallbacksFor<
      CreateUser,
      OnSignIn,
      "password",
      PasswordProfile,
      UsersTable
    >): void {
      attached = attach(createUser, onSignIn);
    },

    /**
     * The provider's functions to export, available once
     * {@link attachUserCallbacks} has run. Accessing them earlier throws, so
     * a module that forgets to attach callbacks fails at eval (push) time,
     * not at the first sign-in.
     */
    get exports() {
      if (attached === undefined) {
        throw new Error(
          "Call attachUserCallbacks before accessing the password " +
            "provider's exports.",
        );
      }
      return attached;
    },
  };
}
