/**
 * The `EmailPassword` provider: accounts have an email address
 * and a password, and the email must be validated before the first sign-in.
 *
 * @module
 */
import { createFunctionHandle } from "convex/server";
import { Infer, v } from "convex/values";
import {
  vSignInComplete,
  vSignInError,
  USE_USER_ID_AS_ACCOUNT_ID,
  type UserCallbacks,
} from "../../lib/types.ts";
import type { AuthCore } from "../core/setup.ts";
import type { ComponentApi } from "./_generated/component.js";
import type { ComponentApi as PasswordComponentApi } from "../password/_generated/component.js";
import {
  validateNewPassword,
  setPasswordUserError,
  verifyPasswordUserError,
} from "../password/validation.ts";
import {
  startFreeAddressUserError,
  completeFreeAddressUserError,
  type EmailSenderConfig,
} from "./validation.ts";
import type { SendEmailRef } from "./helpers.ts";

// TODO: derive this from the component mount path rather than hardcoding it.
const PROVIDER_NAME = "emailPassword";

/**
 * How the provider sends emails: challenge links (through the email
 * component) and security notifications (directly).
 *
 * Only Resend is supported for now, through the `@convex-dev/resend`
 * component. Mount that component in the app and pass its `sendEmail`
 * reference and your Resend API key here.
 *
 * TODO: support other email providers.
 * TODO: offer a first-party zero-configuration email service.
 * TODO: let applications customize the email templates.
 */
export type EmailSenderOptions = {
  kind: "resend";
  /** The mounted Resend component's `lib.sendEmail` reference. */
  sendEmail: SendEmailRef;
  /**
   * The Resend API key. Read it from an environment variable of the
   * deployment (e.g. `env.RESEND_API_KEY`) rather than writing it in the
   * source.
   */
  apiKey: string;
  /**
   * The From address, e.g. `"My App <auth@example.com>"`. Outside test mode
   * the address must be on a domain you verified with Resend.
   */
  from: string;
  /**
   * Resend's test mode. Defaults to `true`, where only Resend test
   * addresses (e.g. `delivered@resend.dev`) are deliverable. Set it to
   * `false` to send real email.
   *
   * TODO(nicolas) Consider removing the option
   */
  testMode?: boolean;
};

/**
 * The landing pages the emailed links point at. The link's `code` query
 * parameter will be appended to these URLs.
 */
export type EmailPasswordUrls = {
  /** Landing page for the sign-up challenge link. */
  signUp: string;
};

/**
 * Options for {@link setupEmailPassword}.
 */
export type EmailPasswordOptions = {
  /**
   * The mounted email component (`components.authEmail`). The provider uses it
   * to track verified emails and to run the challenges.
   */
  component: ComponentApi;
  /**
   * The mounted password component (`components.authPasswordProvider`). The
   * provider drives its `setPassword` / `verifyPassword` mutations.
   */
  passwordComponent: PasswordComponentApi;
  /** How the provider sends emails. */
  emailSender: EmailSenderOptions;
  /** The landing pages the emailed links point at. */
  urls: EmailPasswordUrls;
};

const signUpResult = v.union(
  v.object({
    success: v.literal(true),
    browserSecret: v.string(),
    // The new user. The browser keeps it with the secret and gives both back
    // to `completeSignUp`, which binds the link to this user.
    userId: v.string(),
  }),
  v.object({
    success: v.literal(false),
    userError: v.union(startFreeAddressUserError, setPasswordUserError),
  }),
);

/**
 * The result of `signUp`. On success, the secret the browser must keep for
 * `completeSignUp`; the session arrives only after the email is validated.
 */
export type SignUpResult = Infer<typeof signUpResult>;

const completeSignUpResult = v.union(
  vSignInComplete,
  vSignInError(completeFreeAddressUserError),
);

/** The result of `completeSignUp`: the minted session tokens, or an error. */
export type CompleteSignUpResult = Infer<typeof completeSignUpResult>;

const signInResult = v.union(
  vSignInComplete,
  vSignInError(
    v.union(
      verifyPasswordUserError,
      v.object({ error: v.literal("USER_NOT_FOUND") }),
    ),
  ),
);

/** The result of `signIn`: the minted session tokens, or an error. */
export type SignInResult = Infer<typeof signInResult>;

export type EmailPasswordProfile = Record<string, never>;

/**
 * A password provider where accounts have a validated email address and a password.
 *
 * - Sign-up creates the user immediately but without a session; the user
 *   signs in only after they open the challenge link. Wire it up in
 *   `convex/auth.ts`:
 *
 * ```ts
 * import { env } from "./_generated/server";
 *
 * const core = setupCore({ component: components.auth });
 * export const { signOut, refreshSession, isAuthenticated } = core;
 *
 * export const { signUp, completeSignUp, signIn } = setupEmailPassword(core, {
 *   component: components.authEmail,
 *   passwordComponent: components.authPasswordProvider,
 *   emailSender: {
 *     kind: "resend",
 *     sendEmail: components.resend.lib.sendEmail,
 *     apiKey: env.RESEND_API_KEY,
 *     from: "My App <auth@example.com>",
 *     testMode: false,
 *   },
 *   urls: {
 *     signUp: `${env.SITE_URL}/validate-email`,
 *   },
 * }).attachUserCallback(internal.users.createOrUpdateUser);
 * ```
 *
 * - Sign-in accepts any verified email of the account.
 *
 * Account resolution (email → app user id) is owned by the email component;
 * the password component stores only `{ userId, passwordHash }`.
 */
export function setupEmailPassword<UsersTable extends string>(
  core: AuthCore<UsersTable>,
  options: EmailPasswordOptions,
) {
  const { component, passwordComponent, emailSender, urls } = options;

  /** The Resend runtime options `lib.sendEmail` requires. */
  const senderRuntimeOptions = () => ({
    apiKey: emailSender.apiKey,
    testMode: emailSender.testMode ?? true,
    // TODO: review these values (and make them configurable).
    initialBackoffMs: 30 * 1000,
    retryAttempts: 5,
  });

  /** The sender config the email component's `start` mutations accept. */
  const senderConfig = async (): Promise<EmailSenderConfig> => ({
    kind: "resend",
    sendEmailHandle: await createFunctionHandle(emailSender.sendEmail),
    from: emailSender.from,
    ...senderRuntimeOptions(),
  });

  return {
    /**
     * Supply the app's user callbacks (see {@link UserCallbacks} for how their
     * args must be declared) and get this provider's functions to export.
     */
    attachUserCallbacks({
      createUser,
      onSignIn,
    }: UserCallbacks<typeof PROVIDER_NAME, EmailPasswordProfile, UsersTable>) {
      const { authMutation } = core.bindProvider({
        name: PROVIDER_NAME,
        createUser,
        onSignIn,
      });

      return {
        /**
         * Create a new account: the app user, the account and the password are
         * written immediately, but no session is minted. The user signs in for
         * the first time through `completeSignUp`, after they open the
         * challenge link.
         *
         * Repeated sign-ups with one unvalidated address create separate
         * users; the first completed validation wins, and the others can never
         * sign in.
         */
        signUp: authMutation({
          args: { email: v.string(), password: v.string() },
          returns: signUpResult,
          handler: async (ctx, { email, password }): Promise<SignUpResult> => {
            // Validate both inputs before creating anything, so invalid input
            // never creates a user. `check` runs every precondition of the
            // `start` below (format, rate limits, address not taken) without
            // consuming the limits: a mutation can only roll back by
            // throwing, and these are expected outcomes, not exceptions.
            const emailError = await ctx.runMutation(
              component.challenge.addEmail.check,
              { email },
            );
            if (emailError !== null) {
              return { success: false, userError: emailError };
            }
            const passwordError = validateNewPassword(password);
            if (passwordError !== null) {
              return { success: false, userError: passwordError };
            }

            // Create the app user + account without a session. Accounts are
            // keyed by the app user id, which does not exist before this call
            // mints it, hence the placeholder; sign-in passes the user id
            // itself.
            const { userId } = await ctx.convexAuth.signUpWithoutSession({
              providerAccountId: USE_USER_ID_AS_ACCOUNT_ID,
              profile: {},
            });

            const setResult = await ctx.runMutation(
              passwordComponent.public.setPassword,
              { userId, password },
            );
            if (!setResult.success) {
              // Unexpected: the password was validated above. Throw so the
              // transaction (including the new user) does not commit.
              throw new Error(
                "Unexpected error when setting the password: " +
                  setResult.userError.error,
                { cause: setResult.userError },
              );
            }

            const start = await ctx.runMutation(
              component.challenge.addEmail.start,
              {
                email,
                // The user is new, so this first address becomes primary.
                userId,
                url: urls.signUp,
                emailSender: await senderConfig(),
              },
            );
            if (!start.success) {
              // Unexpected: `check` passed above, in this same transaction.
              // Throw so the new user rolls back rather than being left with
              // no way to validate.
              throw new Error(
                "Unexpected error when starting the email validation: " +
                  start.userError.error,
                { cause: start.userError },
              );
            }

            return {
              success: true,
              browserSecret: start.browserSecret,
              userId,
            };
          },
        }),

        /**
         * Complete a sign-up: validate the email with the code from the link
         * and the secret from the starting browser, then sign the user in.
         * Validation and sign-in happen in one transaction.
         */
        completeSignUp: authMutation({
          args: {
            emailCode: v.string(),
            browserSecret: v.string(),
            userId: v.string(),
          },
          returns: completeSignUpResult,
          handler: async (
            ctx,
            { emailCode, browserSecret, userId },
          ): Promise<CompleteSignUpResult> => {
            const complete = await ctx.runMutation(
              component.challenge.addEmail.complete,
              { emailCode, browserSecret, userId },
            );
            if (!complete.success) {
              return { status: "error", userError: complete.userError };
            }
            const tokens = await ctx.convexAuth.completeSignIn({
              providerAccountId: complete.userId,
              profile: {},
            });
            return { status: "complete", tokens };
          },
        }),

        /**
         * Verify an existing account's password and, on success, mint a
         * session. Any verified email of the account works. Returns
         * `USER_NOT_FOUND` when no account has verified the email and
         * `INVALID_CREDENTIALS` when the password is wrong. (Address existence
         * is already observable via sign-up's `EMAIL_TAKEN`, so distinguishing
         * them here leaks nothing new.)
         */
        signIn: authMutation({
          args: { email: v.string(), password: v.string() },
          returns: signInResult,
          handler: async (ctx, { email, password }): Promise<SignInResult> => {
            const existing = await ctx.runQuery(
              component.verifiedEmails.getUserIdByEmail,
              {
                email,
              },
            );
            if (existing === null) {
              return {
                status: "error",
                userError: { error: "USER_NOT_FOUND" },
              };
            }
            const { userId } = existing;

            const verifyResult = await ctx.runMutation(
              passwordComponent.public.verifyPassword,
              { userId, password },
            );
            if (!verifyResult.success) {
              return { status: "error", userError: verifyResult.userError };
            }

            const tokens = await ctx.convexAuth.completeSignIn({
              providerAccountId: userId,
              profile: {},
            });
            return { status: "complete", tokens };
          },
        }),
      };
    },
  };
}
