/**
 * The `EmailPassword` provider: accounts have an email address
 * and a password, and the email must be validated before the first sign-in.
 *
 * @module
 */
import {
  createFunctionHandle,
  type GenericMutationCtx,
  type GenericDataModel,
} from "convex/server";
import { Infer, v } from "convex/values";
import {
  vSignInComplete,
  vSignInError,
  USE_USER_ID_AS_ACCOUNT_ID,
  type UserCallbacks,
} from "../../lib/types.ts";
import type { AuthCore } from "../core/setup.ts";
import { getAuthUserId } from "../core/userId.ts";
import type { ComponentApi } from "./_generated/component.js";
import type { ComponentApi as PasswordComponentApi } from "../password/_generated/component.js";
import {
  validateNewPassword,
  setPasswordUserError,
  verifyPasswordUserError,
} from "../password/validation.ts";
import {
  startChallengeUserError,
  startFreeAddressUserError,
  completeChallengeUserError,
  completeFreeAddressUserError,
  type EmailSenderConfig,
} from "./validation.ts";
import type { SendEmailRef } from "./helpers.ts";

// TODO: derive this from the component mount path rather than hardcoding it.
const PROVIDER_NAME = "emailPassword";

/**
 * The purpose of the `custom` challenge that account recovery starts. The
 * name carries a prefix so that an application's own custom purposes cannot
 * collide with it.
 */
const RECOVERY_PURPOSE = "convexAuth/emailPassword/recovery";

/**
 * How long a recovery link stays valid. OWASP ASVS v5 6.5.5 requires at most
 * 10 minutes for password-reset flows. TODO: review this value.
 */
const RECOVERY_TTL_MS = 10 * 60 * 1000;

const RECOVERY_EMAIL = {
  subject: "Reset your password",
  intro: "Open this link to reset your password:",
};

/** No account has verified the address that recovery was asked for. */
const vEmailNotFound = v.object({ error: v.literal("EMAIL_NOT_FOUND") });

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
   * The From address, e.g. `"My App <auth@example.com>"`. The address must be
   * on a domain you verified with Resend.
   */
  from: string;
};

/**
 * The landing pages the emailed links point at. The link's `code` query
 * parameter will be appended to these URLs.
 */
export type EmailPasswordUrls = {
  /** Landing page for the sign-up challenge link. */
  signUp: string;
  /** Landing page for the change-email challenge link. */
  changeEmail: string;
  /** Landing page for the password-recovery link. */
  recovery: string;
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

const vNotLoggedIn = v.object({ error: v.literal("NOT_LOGGED_IN") });

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

const changePasswordResult = v.union(
  v.object({ success: v.literal(true) }),
  v.object({
    success: v.literal(false),
    userError: v.union(
      vNotLoggedIn,
      v.object({ error: v.literal("INVALID_CREDENTIALS") }),
      v.object({ error: v.literal("RATE_LIMITED"), retryAfterMs: v.number() }),
      setPasswordUserError,
    ),
  }),
);

/**
 * The result of `changePassword`.
 *
 * `INVALID_CREDENTIALS` and `RATE_LIMITED` are about the current password.
 * The other errors are about the new password.
 */
export type ChangePasswordResult = Infer<typeof changePasswordResult>;

const startChangeEmailResult = v.union(
  v.object({ success: v.literal(true), browserSecret: v.string() }),
  v.object({
    success: v.literal(false),
    userError: v.union(
      vNotLoggedIn,
      verifyPasswordUserError,
      startFreeAddressUserError,
    ),
  }),
);

/** The result of `startChangeEmail`. */
export type StartChangeEmailResult = Infer<typeof startChangeEmailResult>;

const completeChangeEmailResult = v.union(
  v.object({ success: v.literal(true) }),
  v.object({
    success: v.literal(false),
    userError: v.union(vNotLoggedIn, completeFreeAddressUserError),
  }),
);

/** The result of `completeChangeEmail`. */
export type CompleteChangeEmailResult = Infer<typeof completeChangeEmailResult>;

const startRecoveryResult = v.union(
  v.object({ success: v.literal(true), browserSecret: v.string() }),
  v.object({
    success: v.literal(false),
    userError: v.union(startChallengeUserError, vEmailNotFound),
  }),
);

/** The result of `startRecovery`. */
export type StartRecoveryResult = Infer<typeof startRecoveryResult>;

const completeRecoveryResult = v.union(
  vSignInComplete,
  vSignInError(v.union(completeChallengeUserError, setPasswordUserError)),
);

/** The result of `completeRecovery`: the minted session tokens, or an error. */
export type CompleteRecoveryResult = Infer<typeof completeRecoveryResult>;

type MutationCtx = GenericMutationCtx<GenericDataModel>;

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
 * export const {
 *   signUp,
 *   completeSignUp,
 *   signIn,
 *   changePassword,
 *   startRecovery,
 *   completeRecovery,
 *   startChangeEmail,
 *   completeChangeEmail,
 * } = setupEmailPassword(core, {
 *   component: components.authEmail,
 *   passwordComponent: components.authPasswordProvider,
 *   emailSender: {
 *     kind: "resend",
 *     sendEmail: components.resend.lib.sendEmail,
 *     apiKey: env.RESEND_API_KEY,
 *     from: "My App <auth@example.com>",
 *   },
 *   urls: {
 *     signUp: `${env.SITE_URL}/validate-email`,
 *     changeEmail: `${env.SITE_URL}/confirm-email-change`,
 *     recovery: `${env.SITE_URL}/reset-password`,
 *   },
 * }).attachUserCallbacks({ createUser: internal.users.createUser });
 * ```
 *
 * - Sign-in accepts any verified email of the account.
 * - Change-password and change-email require the session *and* the current
 *   password (OWASP ASVS v5 6.2.3), and send a security notification to the
 *   affected address (ASVS 6.3.7).
 * - Recovery proves ownership of a verified email through a 10-minute link,
 *   then sets the new password and signs the user in.
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

  /**
   * Send a security notification (ASVS 6.3.7) directly through the Resend
   * reference. Notifications do not go through the email component: they
   * need no validation state, only a send.
   */
  const notify = async (
    ctx: MutationCtx,
    to: string,
    subject: string,
    text: string,
  ): Promise<void> => {
    await ctx.runMutation(emailSender.sendEmail, {
      options: { ...senderRuntimeOptions(), testMode: false },
      from: emailSender.from,
      to: [to],
      subject,
      text,
    });
  };

  const PASSWORD_CHANGED_SUBJECT = "Your password was changed";
  const PASSWORD_CHANGED_TEXT =
    "The password of your account was changed.\n\n" +
    "If you did this, you can ignore this email. If you did not do " +
    "this, reset your password immediately.";

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

        /**
         * Change the signed-in user's password. Requires the session *and* the
         * current password (OWASP ASVS v5 6.2.3), and notifies the primary
         * email address (ASVS 6.3.7).
         */
        // TODO: option to invalidate the user's other sessions.
        changePassword: authMutation({
          args: { currentPassword: v.string(), newPassword: v.string() },
          returns: changePasswordResult,
          handler: async (
            ctx,
            { currentPassword, newPassword },
          ): Promise<ChangePasswordResult> => {
            const userId = await getAuthUserId(ctx);
            if (userId === null) {
              return { success: false, userError: { error: "NOT_LOGGED_IN" } };
            }

            // Validate the new password before the current password, so that
            // an invalid new password does not consume the rate limit.
            const newPasswordError = validateNewPassword(newPassword);
            if (newPasswordError !== null) {
              return { success: false, userError: newPasswordError };
            }

            // TODO: This doesn’t compose with other providers. If the user doesn’t
            // have a password yet, they currently can’t set one. We should fix this
            // when we have a first-party “auth-flow” concept so that users can
            // re-authenticate another way.
            const verifyResult = await ctx.runMutation(
              passwordComponent.public.verifyPassword,
              { userId, password: currentPassword },
            );
            if (!verifyResult.success) {
              if (verifyResult.userError.error === "RATE_LIMITED") {
                return { success: false, userError: verifyResult.userError };
              }
              // `verifyPassword` also returns format errors. Return
              // INVALID_CREDENTIALS for all of them, so that the user does not
              // think that the new password has a problem.
              verifyResult.userError.error satisfies
                | "PASSWORD_TOO_SHORT"
                | "PASSWORD_TOO_LONG"
                | "PASSWORD_HAS_SURROUNDING_WHITESPACE"
                | "INVALID_CREDENTIALS";
              return {
                success: false,
                userError: { error: "INVALID_CREDENTIALS" },
              };
            }

            const setResult = await ctx.runMutation(
              passwordComponent.public.setPassword,
              { userId, password: newPassword },
            );
            if (!setResult.success) {
              return { success: false, userError: setResult.userError };
            }

            const to = await ctx.runQuery(
              component.verifiedEmails.getPrimaryEmail,
              { userId },
            );
            if (to !== null) {
              await notify(
                ctx,
                to,
                PASSWORD_CHANGED_SUBJECT,
                PASSWORD_CHANGED_TEXT,
              );
            }
            return { success: true };
          },
        }),

        /**
         * Start changing the signed-in user's primary email address. Requires
         * the session *and* the current password (OWASP ASVS v5 6.2.3). Sends
         * a challenge link to the new address; the change happens in
         * `completeChangeEmail`.
         */
        startChangeEmail: authMutation({
          args: { newEmail: v.string(), currentPassword: v.string() },
          returns: startChangeEmailResult,
          handler: async (
            ctx,
            { newEmail, currentPassword },
          ): Promise<StartChangeEmailResult> => {
            const userId = await getAuthUserId(ctx);
            if (userId === null) {
              return { success: false, userError: { error: "NOT_LOGGED_IN" } };
            }

            const verifyResult = await ctx.runMutation(
              passwordComponent.public.verifyPassword,
              { userId, password: currentPassword },
            );
            if (!verifyResult.success) {
              return { success: false, userError: verifyResult.userError };
            }

            const start = await ctx.runMutation(
              component.challenge.changeEmail.start,
              {
                email: newEmail,
                userId,
                url: urls.changeEmail,
                emailSender: await senderConfig(),
              },
            );
            if (!start.success) {
              return { success: false, userError: start.userError };
            }
            return { success: true, browserSecret: start.browserSecret };
          },
        }),

        /**
         * Complete an email change: validate the new address, replace the old
         * primary, and notify the old address (ASVS 6.3.7). No session is
         * minted — the user already has one.
         */
        completeChangeEmail: authMutation({
          args: { emailCode: v.string(), browserSecret: v.string() },
          returns: completeChangeEmailResult,
          handler: async (
            ctx,
            { emailCode, browserSecret },
          ): Promise<CompleteChangeEmailResult> => {
            // The link is bound to the user who started the change, so the
            // same user must be signed in to complete it.
            const userId = await getAuthUserId(ctx);
            if (userId === null) {
              return { success: false, userError: { error: "NOT_LOGGED_IN" } };
            }
            const complete = await ctx.runMutation(
              component.challenge.changeEmail.complete,
              { emailCode, browserSecret, userId },
            );
            if (!complete.success) {
              return { success: false, userError: complete.userError };
            }
            if (complete.previousEmail !== null) {
              await notify(
                ctx,
                complete.previousEmail,
                "Your email address was changed",
                "The email address of your account was changed to " +
                  `${complete.email}.\n\n` +
                  "If you did this, you can ignore this email. If you did " +
                  "not do this, reset your password immediately.",
              );
            }
            return { success: true };
          },
        }),

        /**
         * Start a password recovery: send a reset link (valid 10 minutes) to a
         * verified email address. Any verified address of the account works,
         * not only the primary one.
         *
         * `EMAIL_NOT_FOUND` is surfaced to the caller. This reveals whether an
         * address has an account, which sign-up's `EMAIL_TAKEN` reveals
         * anyway; the recipe accepts that trade-off for a clearer flow.
         * TODO: the lookups are not rate limited, so a client can probe
         * addresses freely. Add a consuming per-IP limit on the lookup.
         */
        startRecovery: authMutation({
          args: { email: v.string() },
          returns: startRecoveryResult,
          handler: async (ctx, { email }): Promise<StartRecoveryResult> => {
            // The address must belong to an account. The check runs again at
            // completion: the component does not verify the address for a
            // custom challenge.
            const account = await ctx.runQuery(
              component.verifiedEmails.getUserIdByEmail,
              { email },
              // TODO: Should we allow users to start a recovery flow through
              // a secondary email? Or support options to customize this?
            );
            if (account === null) {
              return {
                success: false,
                userError: { error: "EMAIL_NOT_FOUND" },
              };
            }

            const start = await ctx.runMutation(
              component.challenge.custom.start,
              {
                // Send the link to the stored address, not to the typed one.
                // The lookup ignores the case, but a mail server can treat
                // `Alice@` and `alice@` as two mailboxes. Only the case that
                // the owner verified must receive a recovery link.
                email: account.email,
                purpose: RECOVERY_PURPOSE,
                // Nobody is signed in: the account is found again from the
                // verified address at completion.
                userId: null,
                url: urls.recovery,
                emailSender: await senderConfig(),
                ttlMs: RECOVERY_TTL_MS,
                ...RECOVERY_EMAIL,
              },
            );
            if (!start.success) {
              return { success: false, userError: start.userError };
            }
            return { success: true, browserSecret: start.browserSecret };
          },
        }),

        /**
         * Complete a password recovery: the link code + browser secret prove
         * ownership of the email, so set the new password and sign the user
         * in, in one transaction. Notifies the primary email (ASVS 6.3.7).
         */
        completeRecovery: authMutation({
          args: {
            emailCode: v.string(),
            browserSecret: v.string(),
            newPassword: v.string(),
          },
          returns: completeRecoveryResult,
          handler: async (
            ctx,
            { emailCode, browserSecret, newPassword },
          ): Promise<CompleteRecoveryResult> => {
            // Validate the password before claiming the one-shot link, so a
            // rejected password does not burn the link.
            const passwordError = validateNewPassword(newPassword);
            if (passwordError !== null) {
              return { status: "error", userError: passwordError };
            }

            const complete = await ctx.runMutation(
              component.challenge.custom.complete,
              {
                emailCode,
                browserSecret,
                purpose: RECOVERY_PURPOSE,
                userId: null,
              },
            );
            if (!complete.success) {
              return { status: "error", userError: complete.userError };
            }

            // The link proves control of the address, not of an account. The
            // address must still be a verified address of an account: it
            // could have moved to another user, or been removed, since the
            // flow started. Any verified address of the account can reset
            // the password, because each of them passed the same ownership
            // challenge.
            const account = await ctx.runQuery(
              component.verifiedEmails.getUserIdByEmail,
              { email: complete.email },
              // TODO: Should we allow users to start a recovery flow through
              // a secondary email? Or support options to customize this?
            );
            if (account === null) {
              return {
                status: "error",
                userError: { error: "INVALID_CHALLENGE" },
              };
            }

            const { userId } = account;
            const setResult = await ctx.runMutation(
              passwordComponent.public.setPassword,
              { userId, password: newPassword },
            );
            if (!setResult.success) {
              // Unexpected: the password was validated above. Throw so the
              // claimed link rolls back rather than being burned.
              throw new Error(
                "Unexpected error when setting the password: " +
                  setResult.userError.error,
                { cause: setResult.userError },
              );
            }

            const tokens = await ctx.convexAuth.completeSignIn({
              providerAccountId: userId,
              profile: {},
            });

            // The notification goes to the primary address, which can be
            // different from the address that received the link.
            await notify(
              ctx,
              (await ctx.runQuery(component.verifiedEmails.getPrimaryEmail, {
                userId,
              })) ?? account.email,
              PASSWORD_CHANGED_SUBJECT,
              PASSWORD_CHANGED_TEXT,
            );
            return { status: "complete", tokens };
          },
        }),
      };
    },
  };
}
