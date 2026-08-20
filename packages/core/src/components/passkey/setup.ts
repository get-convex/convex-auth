import { mutationGeneric } from "convex/server";
import { Infer, v } from "convex/values";
import {
  vSignInSuccess,
  USE_USER_ID_AS_ACCOUNT_ID,
  type UserCallbacks,
} from "../../lib/types";
import type { AuthCore } from "../core/setup";
import type { ComponentApi } from "./_generated/component.js";
import type { ComponentApi as UsernameComponentApi } from "../username/_generated/component.js";
import {
  setUsernameUserError,
  validateUsernameFormat,
} from "../username/validation";
import {
  finishAuthenticationUserError,
  finishRegistrationUserError,
} from "./validation";

/**
 * Options for {@link setupUsernamePasskey}.
 */
export type UsernamePasskeyOptions = {
  /**
   * The mounted passkey component (`components.authPasskey`). The recipe
   * drives its registration and authentication ceremonies.
   */
  component: ComponentApi;
  /**
   * The mounted username component (`components.authUsername`). The recipe
   * uses it to map a username onto the app user id: it stores the username
   * at sign-up and reads it back at sign-in.
   */
  usernameComponent: UsernameComponentApi;
  /**
   * The relying party ID: usually the registrable domain at which the app
   * is served (for example, "example.com" or "localhost"). Only web pages
   * on the same domain (or its subdomains) can use the passkeys.
   * See https://web.dev/articles/webauthn-rp-id
   */
  rpId: string;
  /**
   * The exact origin of the ceremonies (for example,
   * "https://app.example.com" or "http://localhost:5173").
   */
  origin: string;
  /**
   * The human-readable relying party name that the browser shows in the
   * passkey dialog. WebAuthn requires it on the client. When not set, the
   * `rpId` is used.
   */
  rpName?: string;
};

// TODO: derive this from the component mount path rather than hardcoding it.
const PROVIDER_NAME = "passkey";

const startSignInResult = v.union(
  // The username has an account: authenticate with a passkey of that
  // account. The challenge is bound to the user.
  v.object({
    success: v.literal(true),
    step: v.literal("authenticate"),
    challenge: v.bytes(),
    allowCredentials: v.array(v.bytes()),
    rpId: v.string(),
  }),
  // The username is free: register a new account with a new passkey.
  v.object({
    success: v.literal(true),
    step: v.literal("register"),
    challenge: v.bytes(),
    // The WebAuthn user handle (`user.id`) for the `create()` call.
    userHandle: v.bytes(),
    excludeCredentials: v.array(v.bytes()),
    rpId: v.string(),
    rpName: v.string(),
  }),
  v.object({ success: v.literal(false), userError: setUsernameUserError }),
);

/**
 * The result of `startSignIn`: which ceremony the client must run, with
 * the data for the WebAuthn call, or a user-facing `userError`.
 */
export type StartSignInResult = Infer<typeof startSignInResult>;

const startAutofillSignInResult = v.object({
  challenge: v.bytes(),
  rpId: v.string(),
});

/**
 * The result of `startAutofillSignIn`: an unbound challenge for a
 * conditional-mediation (passkey autofill) `get()` call.
 */
export type StartAutofillSignInResult = Infer<typeof startAutofillSignInResult>;

const finishSignUpResult = v.union(
  vSignInSuccess,
  v.object({
    success: v.literal(false),
    userError: v.union(finishRegistrationUserError, setUsernameUserError),
  }),
);

/**
 * The result of `finishSignUp`.
 *
 * On success the minted session tokens, otherwise a user-facing `userError`.
 */
export type FinishSignUpResult = Infer<typeof finishSignUpResult>;

const finishSignInResult = v.union(
  v.object({
    ...vSignInSuccess.fields,
    // The username of the account, for display. `null` when the app
    // removed the username of the user.
    username: v.union(v.string(), v.null()),
  }),
  v.object({
    success: v.literal(false),
    userError: finishAuthenticationUserError,
  }),
);

/**
 * The result of `finishSignIn`.
 *
 * On success the minted session tokens and the username of the account,
 * otherwise a user-facing `userError`.
 */
export type FinishSignInResult = Infer<typeof finishSignInResult>;

/**
 * An identifier-first username + passkey recipe: the user types a username;
 * when the username has an account, the user authenticates with a passkey
 * of that account; when the username is free, the user registers a new
 * account immediately. Wire it up in `convex/auth.ts`:
 *
 * ```ts
 * const core = setupCore({ component: components.auth });
 * export const { signOut, refreshSession, isAuthenticated } = core;
 *
 * export const { startSignIn, startAutofillSignIn, finishSignUp, finishSignIn } =
 *   setupUsernamePasskey(core, {
 *     component: components.authPasskey,
 *     usernameComponent: components.authUsername,
 *     rpId: "localhost",
 *     origin: "http://localhost:5173",
 *   }).attachUserCallbacks({ createUser: internal.users.createUserPasskey });
 * ```
 *
 * The app re-exports the returned `startSignIn` / `startAutofillSignIn` /
 * `finishSignUp` / `finishSignIn` mutations so its clients can call them.
 * The React hooks in `@convex-dev/auth/providers/passkey/react` drive the
 * WebAuthn ceremonies in the browser against these four functions.
 */
// TODO(nicolas) There is no flow yet to add more passkeys to an
// existing account, or to delete one, from this provider. The
// component supports it (`startRegistration` with a `userId`,
// `deletePasskey`); the provider does not expose it yet.
export function setupUsernamePasskey<UsersTable extends string>(
  core: AuthCore<UsersTable>,
  options: UsernamePasskeyOptions,
) {
  const { component, usernameComponent, rpId, origin } = options;
  const rpName = options.rpName ?? rpId;

  return {
    /**
     * Supply the app's user callbacks (see {@link UserCallbacks} for how their
     * args must be declared) and get this provider's functions to export.
     */
    attachUserCallbacks({
      createUser,
      onSignIn,
    }: UserCallbacks<"passkey", { username: string | null }, UsersTable>) {
      const { authMutation } = core.bindProvider({
        name: PROVIDER_NAME,
        createUser,
        onSignIn,
      });

      return {
        /**
         * The identifier-first entry point: look the username up and start
         * the matching ceremony.
         *
         * - The username has an account: start an authentication ceremony
         *   that is bound to that user (`step: "authenticate"`).
         * - The username is free: start a registration ceremony for a new
         *   account (`step: "register"`). The account is not created here;
         *   `finishSignUp` creates everything in one transaction.
         *
         * Note: this flow lets an attacker enumerate which usernames exist.
         * That is intrinsic to identifier-first passkey sign-in (and account
         * existence is also observable through sign-up), so it is accepted.
         */
        startSignIn: mutationGeneric({
          args: { username: v.string() },
          returns: startSignInResult,
          handler: async (ctx, { username }): Promise<StartSignInResult> => {
            // Reject a malformed username before any ceremony starts.
            const usernameError = validateUsernameFormat(username);
            if (usernameError !== null) {
              return { success: false, userError: usernameError };
            }

            const userId = await ctx.runQuery(
              usernameComponent.public.getUserIdByUsername,
              { username },
            );
            if (userId !== null) {
              // When the user has no passkeys (possible only if a flow outside
              // this provider deletes the last passkey of a user), this branch
              // returns an empty `allowCredentials` and the user can neither
              // sign in nor register again.
              // TODO: Should we throw an error instead?
              const { challenge, allowCredentials } = await ctx.runMutation(
                component.authentication.startAuthentication,
                { userId },
              );
              return {
                success: true,
                step: "authenticate",
                challenge,
                allowCredentials,
                rpId,
              };
            }

            const { challenge, userHandle, excludeCredentials } =
              await ctx.runMutation(component.registration.startRegistration, {
                userId: null,
              });
            return {
              success: true,
              step: "register",
              challenge,
              userHandle,
              excludeCredentials,
              rpId,
              rpName,
            };
          },
        }),

        /**
         * Start a conditional-mediation (passkey autofill) ceremony: an
         * authentication challenge that is not bound to a user. The passkey
         * that the user selects identifies the account.
         */
        startAutofillSignIn: mutationGeneric({
          args: {},
          returns: startAutofillSignInResult,
          handler: async (ctx): Promise<StartAutofillSignInResult> => {
            const { challenge } = await ctx.runMutation(
              component.authentication.startAuthentication,
              {},
            );
            return { challenge, rpId };
          },
        }),

        /**
         * Create a new account: the user, the username, the account, the
         * session, and the passkey, all in ONE mutation. When any step
         * fails, nothing is committed.
         *
         * The order of the steps gives that guarantee:
         * 1. Checks that write nothing: the username format, the username
         *    conflict, and `checkRegistration` (the full WebAuthn
         *    verification as a query). Each correctable failure returns a
         *    `userError` here, before anything exists.
         * 2. Writes that cannot fail after the checks: `completeSignUp` mints
         *    the user, the account, and the session, `setUsername` stores the
         *    username, and `finishRegistration` stores the passkey. None of
         *    them can fail after step 1 inside the same transaction, so a
         *    failure throws and rolls everything back.
         */
        finishSignUp: authMutation({
          args: {
            username: v.string(),
            attestationObject: v.bytes(),
            clientDataJSON: v.bytes(),
          },
          returns: finishSignUpResult,
          handler: async (ctx, args): Promise<FinishSignUpResult> => {
            const { username } = args;
            const usernameError = validateUsernameFormat(username);
            if (usernameError !== null) {
              return { success: false, userError: usernameError };
            }

            // Fail early if the username is taken
            const existing = await ctx.runQuery(
              usernameComponent.public.getUserIdByUsername,
              { username },
            );
            if (existing !== null) {
              return { success: false, userError: { error: "USERNAME_TAKEN" } };
            }

            // Fail early if the passkey registration fails
            const checkResult = await ctx.runQuery(
              component.registration.checkRegistration,
              {
                expectedRpId: rpId,
                expectedOrigin: origin,
                attestationObject: args.attestationObject,
                clientDataJSON: args.clientDataJSON,
              },
            );
            if (!checkResult.success) {
              return { success: false, userError: checkResult.userError };
            }

            // Create the account + app user (via the app's createUser) and
            // mint the session.
            //
            // TODO(nicolas) The app's user callbacks should not receive a
            // provider account ID for this provider at all: the value is an
            // internal key ("" at sign-up, the user id afterwards) with no
            // meaning to the app. We will probably improve this when
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
              // Not possible: the username format was validated and the
              // username was free above, in the same transaction. Throwing
              // rolls everything back.
              throw new Error(
                "Unexpected error when setting the username: " +
                  setUsernameResult.userError.error,
                { cause: setUsernameResult.userError },
              );
            }

            // Store the verified credential, link the handle to the new
            // user, and consume the challenge.
            const registrationResult = await ctx.runMutation(
              component.registration.finishRegistration,
              {
                expectedRpId: rpId,
                expectedOrigin: origin,
                verifiedUserId: tokens.userId,
                attestationObject: args.attestationObject,
                clientDataJSON: args.clientDataJSON,
              },
            );
            if (!registrationResult.success) {
              // Not possible: `checkRegistration` succeeded above, in the
              // same transaction. Throwing rolls everything back.
              throw new Error(
                "Unexpected error when storing the passkey: " +
                  registrationResult.userError.error,
                { cause: registrationResult.userError },
              );
            }

            return { success: true, tokens };
          },
        }),

        /**
         * Verify a passkey assertion and, on success, mint a session.
         *
         * The function serves both ceremonies that produce an assertion: the
         * username-first branch (`startSignIn` → `step: "authenticate"`, a
         * challenge bound to the user) and passkey autofill
         * (`startAutofillSignIn`, an unbound challenge where the credential
         * identifies the user).
         *
         * The `username` in the profile that the app's user callbacks
         * receive can be `null` on an autofill sign-in: the passkey
         * identifies a user whose username the app removed.
         */
        finishSignIn: authMutation({
          args: {
            credentialId: v.bytes(),
            authenticatorData: v.bytes(),
            clientDataJSON: v.bytes(),
            signature: v.bytes(),
          },
          returns: finishSignInResult,
          handler: async (ctx, args): Promise<FinishSignInResult> => {
            const authenticationResult = await ctx.runMutation(
              component.authentication.finishAuthentication,
              {
                expectedRpId: rpId,
                expectedOrigin: origin,
                credentialId: args.credentialId,
                authenticatorData: args.authenticatorData,
                clientDataJSON: args.clientDataJSON,
                signature: args.signature,
              },
            );
            if (!authenticationResult.success) {
              return {
                success: false,
                userError: authenticationResult.userError,
              };
            }

            const { userId } = authenticationResult;
            const username = await ctx.runQuery(
              usernameComponent.public.getUsername,
              { userId },
            );

            const tokens = await ctx.convexAuth.completeSignIn({
              providerAccountId: userId,
              profile: { username },
            });
            return { success: true, tokens, username };
          },
        }),
      };
    },
  };
}
