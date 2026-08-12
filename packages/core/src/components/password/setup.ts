import { mutationGeneric } from "convex/server";
import { Infer, v } from "convex/values";
import { defineProvider, vTokenBundle } from "../../lib/types";
import type { ComponentApi } from "./_generated/component.js";
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
};

// TODO: derive this from the component mount path rather than hardcoding it.
const PROVIDER_NAME = "password";

// Used to compare usernames case-insensitively.
function normalizeUsername(username: string): string {
  return username.toLowerCase();
}

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
    userError: v.union(
      setPasswordUserError,
      v.object({ error: v.literal("USERNAME_TAKEN") }),
    ),
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
 *     provider(UsernamePassword, { component: components.authPasswordProvider }),
 *   ],
 * }).attachUserCallback(internal.users.upsertFromAuth);
 * ```
 *
 * The app re-exports the returned `signUpWithPassword` / `signInWithPassword`
 * mutations so its clients can call them.
 *
 * Account resolution (username → app user id) is owned by the core's `accounts`
 * table: the recipe uses the lowercased username as the provider account id, and
 * looks it up with the `resolveUserId` helper the core supplies. The password
 * component itself stores only `{ userId, passwordHash }` and knows nothing about
 * usernames.
 */
export const UsernamePassword = defineProvider({
  name: PROVIDER_NAME,
  setup: (
    { completeSignIn, resolveUserId },
    options: UsernamePasswordOptions,
  ) => {
    const { component } = options;

    return {
      /**
       * Create a new account: reject a taken username or an invalid password,
       * otherwise create the user + session and store the password.
       */
      signUpWithPassword: mutationGeneric({
        args: { username: v.string(), password: v.string() },
        returns: signUpResult,
        handler: async (ctx, { username, password }): Promise<SignUpResult> => {
          // Validate the password *before* creating anything, so an invalid
          // password never mints a session. (`setPassword` re-validates, but by
          // then the account would already exist.)
          const userError = validatePasswordInputFormat(password);
          if (userError !== null) {
            return { success: false, userError };
          }

          const normalizedUsername = normalizeUsername(username);
          const existing = await resolveUserId(ctx, normalizedUsername);
          if (existing !== null) {
            return { success: false, userError: { error: "USERNAME_TAKEN" } };
          }

          // Create the account + app user (via the app's createOrUpdateUser) and
          // mint the session. `profile.username` keeps the original casing for
          // display; the account is keyed by the lowercased `id`.
          const tokens = await completeSignIn(ctx, {
            provider: PROVIDER_NAME,
            providerAccountId: normalizedUsername,
            profile: { username },
          });

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
          const id = normalizeUsername(username);
          const userId = await resolveUserId(ctx, id);
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

          const tokens = await completeSignIn(ctx, {
            provider: PROVIDER_NAME,
            providerAccountId: id,
            profile: { username },
          });
          return { success: true, tokens };
        },
      }),
    };
  },
});
