import { mutationGeneric } from "convex/server";
import { Infer, v } from "convex/values";
import { defineProvider, vTokenBundle } from "../../lib/types";
import type { ComponentApi } from "./_generated/component.js";
import type { ComponentApi as UsernameComponentApi } from "../username/_generated/component.js";
import {
  setUsernameUserError,
  validateUsernameFormat,
} from "../username/validation";
import {
  validatePasswordInputFormat,
  setPasswordUserError,
  verifyPasswordUserError,
} from "./validation";

/**
 * Options for {@link UsernamePassword}.
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

// TODO: derive this from the component mount path rather than hardcoding it.
const PROVIDER_NAME = "password";

// A given user has only zero or one “provider account ID”,
// so there is no need for having a value here.
const EMPTY_PROVIDER_ACCOUNT_ID = "";

const signInResult = v.union(
  v.object({ success: v.literal(true), tokens: vTokenBundle }),
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
  v.object({ success: v.literal(true), tokens: vTokenBundle }),
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
 * with no email or email verification. Wire it into `setupCore`:
 *
 * ```ts
 * setupCore({
 *   component: components.core,
 *   providers: [
 *     provider(UsernamePassword, {
 *       component: components.authPasswordProvider,
 *       usernameComponent: components.authUsername,
 *     }),
 *   ],
 * }).attachUserCallback(internal.users.upsertFromAuth);
 * ```
 *
 * The app re-exports the returned `signUpWithPassword` / `signInWithPassword`
 * mutations so its clients can call them.
 *
 * Account resolution (username → app user id) is owned by the username
 * component: the recipe stores the username there at sign-up, and reads the
 * user id back from it at sign-in. The password component itself stores only
 * `{ userId, passwordHash }` and knows nothing about usernames.
 */
export const UsernamePassword = defineProvider({
  name: PROVIDER_NAME,
  setup: ({ completeSignIn }, options: UsernamePasswordOptions) => {
    const { component, usernameComponent } = options;

    return {
      /**
       * Create a new account: reject a taken username or an invalid password,
       * otherwise create the user + session and store the username and the
       * password.
       */
      signUpWithPassword: mutationGeneric({
        args: { username: v.string(), password: v.string() },
        returns: signUpResult,
        handler: async (ctx, { username, password }): Promise<SignUpResult> => {
          // Validate the username and the password *before* creating
          // anything, so invalid input never mints a session.
          // (`setUsername` and `setPassword` do the same checks again, but by
          // then the account would already exist.)
          // TODO(nicolas) Make the first-party providers apply stronger validation rules by default
          const usernameError = validateUsernameFormat(username);
          if (usernameError !== null) {
            return { success: false, userError: usernameError };
          }
          const userError = validatePasswordInputFormat(password);
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

          // Create the account + app user (via the app's createOrUpdateUser) and
          // mint the session. `profile.username` keeps the original casing for
          // display; the account is keyed by the normalized `id`.
          //
          // TODO(nicolas) The username component now owns the username → user
          // id mapping, so the account no longer needs to be keyed by the
          // username. Give the account a stable, opaque id instead.
          const tokens = await completeSignIn(ctx, {
            provider: PROVIDER_NAME,
            providerAccountId: EMPTY_PROVIDER_ACCOUNT_ID,
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
      signInWithPassword: mutationGeneric({
        args: { username: v.string(), password: v.string() },
        returns: signInResult,
        handler: async (ctx, { username, password }): Promise<SignInResult> => {
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

          // TODO(nicolas) See the TODO in `signUpWithPassword`: the account
          // no longer needs to be keyed by the username.
          const tokens = await completeSignIn(ctx, {
            provider: PROVIDER_NAME,
            providerAccountId: EMPTY_PROVIDER_ACCOUNT_ID,
            profile: { username },
          });
          return { success: true, tokens };
        },
      }),
    };
  },
});
