/**
 * The `EmailPassword` provider recipe: accounts are an `(email, password)`
 * pair, and the email must be validated before the first sign-in.
 *
 * SSR note: only `signIn`, `completeSignUp` and `completeRecovery` return the
 * shared `vSignInSuccess` envelope, so only these three may go on the sign-in
 * proxy allowlist. The flow-starting functions return
 * `{ success: true, secret }`; the proxy does not recognize that shape and
 * responds with a 500 (it fails closed), so route them to the deployment
 * directly.
 *
 * @module
 */
import {
  createFunctionHandle,
  queryGeneric,
  type FunctionReference,
  type GenericMutationCtx,
  type GenericDataModel,
} from "convex/server";
import { Infer, v } from "convex/values";
import {
  vSignInSuccess,
  USE_USER_ID_AS_ACCOUNT_ID,
  type CreateOrUpdateUserFn,
} from "../../lib/types.ts";
import type { AuthCore } from "../core/setup.ts";
import type { ComponentApi } from "./_generated/component.js";
import type { ComponentApi as PasswordComponentApi } from "../password/_generated/component.js";
import {
  validatePasswordInputFormat,
  setPasswordUserError,
  verifyPasswordUserError,
} from "../password/validation.ts";
import {
  validateEmailFormat,
  startChallengeUserError,
  completeChallengeUserError,
  vChallengeStatus,
  type EmailSenderConfig,
  type ChallengeStatus,
} from "./validation.ts";

// TODO: derive this from the component mount path rather than hardcoding it.
const PROVIDER_NAME = "emailPassword";

/**
 * The arguments the recipe sends to the `@convex-dev/resend` component's
 * `lib.sendEmail` mutation. Typed structurally so `@convex-dev/resend` stays
 * out of this package's dependencies; the app supplies the real reference
 * (`components.resend.lib.sendEmail`) and TypeScript checks it against this
 * shape.
 */
type SendEmailArgs = {
  options: {
    apiKey: string;
    testMode: boolean;
    initialBackoffMs: number;
    retryAttempts: number;
  };
  from: string;
  to: string[];
  subject?: string;
  html?: string;
  text?: string;
};

type SendEmailReference = FunctionReference<
  "mutation",
  "internal",
  SendEmailArgs,
  string
>;

/**
 * How the recipe sends emails: challenge links (through the email
 * component) and security notifications (directly).
 *
 * Only Resend is supported for now, through the `@convex-dev/resend`
 * component. Mount that component in the app and pass its `sendEmail`
 * reference here. The Resend API key comes from the `RESEND_API_KEY`
 * environment variable of the app deployment.
 *
 * TODO: support other email providers.
 * TODO: offer a first-party zero-configuration email service.
 * TODO: let applications customize the email templates.
 */
export type EmailSenderOptions = {
  kind: "resend";
  /** The mounted Resend component's `lib.sendEmail` reference. */
  sendEmail: SendEmailReference;
  /** The From address, e.g. `"My App <auth@example.com>"`. */
  from: string;
  /**
   * Resend's test mode. Defaults to `true`, where only Resend test
   * addresses (e.g. `delivered@resend.dev`) are deliverable. Set it to
   * `false` to send real email.
   */
  testMode?: boolean;
};

/**
 * The landing pages the emailed links point at. The link's `code` query
 * parameter is appended to these URLs.
 *
 * These are recipe options, not client arguments, on purpose: a
 * client-supplied URL would let any caller send phishing links from the
 * app's legitimate sender address.
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
   * The mounted email component (`components.authEmail`). The recipe uses it
   * to track verified emails and to run the challenges.
   */
  component: ComponentApi;
  /**
   * The mounted password component (`components.authPasswordProvider`). The
   * recipe drives its `setPassword` / `verifyPassword` mutations.
   */
  passwordComponent: PasswordComponentApi;
  /** How the recipe sends emails. */
  emailSender: EmailSenderOptions;
  /** The landing pages the emailed links point at. */
  urls: EmailPasswordUrls;
};

const vNotLoggedIn = v.object({ error: v.literal("NOT_LOGGED_IN") });

const signUpResult = v.union(
  v.object({ success: v.literal(true), secret: v.string() }),
  v.object({
    success: v.literal(false),
    userError: v.union(startChallengeUserError, setPasswordUserError),
  }),
);

/**
 * The result of `signUp`. On success, the secret the browser must keep for
 * `completeSignUp`; the session arrives only after the email is validated.
 */
export type SignUpResult = Infer<typeof signUpResult>;

const completeSignUpResult = v.union(
  vSignInSuccess,
  v.object({
    success: v.literal(false),
    userError: completeChallengeUserError,
  }),
);

/** The result of `completeSignUp`: the minted session tokens, or an error. */
export type CompleteSignUpResult = Infer<typeof completeSignUpResult>;

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

/** The result of `signIn`: the minted session tokens, or an error. */
export type SignInResult = Infer<typeof signInResult>;

const changePasswordResult = v.union(
  v.object({ success: v.literal(true) }),
  v.object({
    success: v.literal(false),
    userError: v.union(
      vNotLoggedIn,
      verifyPasswordUserError,
      setPasswordUserError,
    ),
  }),
);

/** The result of `changePassword`. */
export type ChangePasswordResult = Infer<typeof changePasswordResult>;

const startChangeEmailResult = v.union(
  v.object({ success: v.literal(true), secret: v.string() }),
  v.object({
    success: v.literal(false),
    userError: v.union(
      vNotLoggedIn,
      verifyPasswordUserError,
      startChallengeUserError,
    ),
  }),
);

/** The result of `startChangeEmail`. */
export type StartChangeEmailResult = Infer<typeof startChangeEmailResult>;

const completeChangeEmailResult = v.union(
  v.object({ success: v.literal(true) }),
  v.object({
    success: v.literal(false),
    userError: completeChallengeUserError,
  }),
);

/** The result of `completeChangeEmail`. */
export type CompleteChangeEmailResult = Infer<typeof completeChangeEmailResult>;

const startRecoveryResult = v.union(
  v.object({ success: v.literal(true), secret: v.string() }),
  v.object({
    success: v.literal(false),
    userError: startChallengeUserError,
  }),
);

/** The result of `startRecovery`. */
export type StartRecoveryResult = Infer<typeof startRecoveryResult>;

const completeRecoveryResult = v.union(
  vSignInSuccess,
  v.object({
    success: v.literal(false),
    userError: v.union(completeChallengeUserError, setPasswordUserError),
  }),
);

/** The result of `completeRecovery`: the minted session tokens, or an error. */
export type CompleteRecoveryResult = Infer<typeof completeRecoveryResult>;

type MutationCtx = GenericMutationCtx<GenericDataModel>;

/** The profile the recipe reports to the app's create-or-update-user callback. */
export type EmailPasswordProfile = { email: string };

/**
 * A password recipe where every account is an `(email, password)` pair:
 *
 * - Sign-up creates the user immediately but without a session; the user
 *   signs in only after they open the challenge link. Wire it up in
 *   `convex/auth.ts`:
 *
 * ```ts
 * const core = setupCore({ component: components.auth });
 * export const { signOut, refreshSession, isAuthenticated } = core;
 *
 * export const { signUp, completeSignUp, signIn } = setupEmailPassword(core, {
 *   component: components.authEmail,
 *   passwordComponent: components.authPasswordProvider,
 *   emailSender: {
 *     kind: "resend",
 *     sendEmail: components.resend.lib.sendEmail,
 *     from: "My App <auth@example.com>",
 *   },
 *   urls: {
 *     signUp: `${process.env.SITE_URL}/validate-email`,
 *     changeEmail: `${process.env.SITE_URL}/confirm-email-change`,
 *     recovery: `${process.env.SITE_URL}/reset-password`,
 *   },
 * }).attachUserCallback(internal.users.createOrUpdateUser);
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
  const senderRuntimeOptions = () => {
    const apiKey = process.env.RESEND_API_KEY;
    if (apiKey === undefined || apiKey === "") {
      throw new Error(
        "Set the RESEND_API_KEY environment variable on your deployment: " +
          "the EmailPassword provider sends email through Resend.",
      );
    }
    return {
      apiKey,
      testMode: emailSender.testMode ?? true,
      // TODO: review these values (and make them configurable).
      initialBackoffMs: 30 * 1000,
      retryAttempts: 5,
    };
  };

  /** The sender config the email component's `challenge.start` accepts. */
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
      options: senderRuntimeOptions(),
      from: emailSender.from,
      to: [to],
      subject,
      text,
    });
  };

  /** The user's primary verified email, or `null`. */
  const primaryEmail = async (
    ctx: MutationCtx,
    userId: string,
  ): Promise<string | null> => {
    const emails = await ctx.runQuery(component.verifiedEmails.getEmails, {
      userId,
    });
    return emails.find((entry) => entry.isPrimary)?.email ?? null;
  };

  /** The signed-in user's id, or `null` when there is no session. */
  const sessionUserId = async (ctx: MutationCtx): Promise<string | null> => {
    const identity = await ctx.auth.getUserIdentity();
    return identity === null ? null : identity.subject;
  };

  const PASSWORD_CHANGED_SUBJECT = "Your password was changed";
  const PASSWORD_CHANGED_TEXT =
    "The password of your account was changed.\n\n" +
    "If you did this, you can ignore this email. If you did not do " +
    "this, reset your password immediately.";

  return {
    /**
     * Supply the app's create-or-update-user mutation (see
     * {@link CreateOrUpdateUserFn} for how its args must be declared) and
     * get this provider's functions to export.
     */
    attachUserCallback(
      createOrUpdateUser: CreateOrUpdateUserFn<
        typeof PROVIDER_NAME,
        EmailPasswordProfile,
        UsersTable
      >,
    ) {
      const { authMutation } = core.bindProvider({
        name: PROVIDER_NAME,
        createOrUpdateUser,
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
         * sign in. TODO: clean up users whose validation expired.
         */
        signUp: authMutation({
          args: { email: v.string(), password: v.string() },
          returns: signUpResult,
          handler: async (ctx, { email, password }): Promise<SignUpResult> => {
            // Validate both inputs before creating anything, so invalid input
            // never creates a user.
            const emailError = validateEmailFormat(email);
            if (emailError !== null) {
              return { success: false, userError: emailError };
            }
            const passwordError = validatePasswordInputFormat(password);
            if (passwordError !== null) {
              return { success: false, userError: passwordError };
            }

            const existing = await ctx.runQuery(
              component.verifiedEmails.getUserIdByEmail,
              { email },
            );
            if (existing !== null) {
              return { success: false, userError: { error: "EMAIL_TAKEN" } };
            }

            // Pre-check the rate limits before creating the user: a mutation
            // can only roll back by throwing, and a rate limit is an expected
            // outcome, not an exception.
            const check = await ctx.runMutation(
              component.challenge.checkStart,
              { email },
            );
            if (!check.ok) {
              return {
                success: false,
                userError: {
                  error: "RATE_LIMITED",
                  retryAfterMs: check.retryAfterMs,
                },
              };
            }

            // Create the app user + account without a session. Accounts are
            // keyed by the app user id, which does not exist before this call
            // mints it, hence the placeholder; sign-in passes the user id
            // itself.
            const { userId } = await ctx.convexAuth.createAccount({
              providerAccountId: USE_USER_ID_AS_ACCOUNT_ID,
              profile: { email },
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

            const start = await ctx.runMutation(component.challenge.start, {
              email,
              purpose: { kind: "addEmail", userId, setPrimary: true },
              url: urls.signUp,
              emailSender: await senderConfig(),
            });
            if (!start.success) {
              // Unexpected: the address was free and the rate limits passed
              // above, in this same transaction. Throw so the new user rolls
              // back rather than being left with no way to validate.
              throw new Error(
                "Unexpected error when starting the email validation: " +
                  start.userError.error,
                { cause: start.userError },
              );
            }

            return { success: true, secret: start.secret };
          },
        }),

        /**
         * Complete a sign-up: validate the email with the code from the link
         * and the secret from the starting browser, then sign the user in.
         * Validation and sign-in happen in one transaction.
         */
        completeSignUp: authMutation({
          args: { code: v.string(), secret: v.string() },
          returns: completeSignUpResult,
          handler: async (
            ctx,
            { code, secret },
          ): Promise<CompleteSignUpResult> => {
            const complete = await ctx.runMutation(
              component.challenge.complete,
              { code, secret, purpose: "addEmail" },
            );
            if (!complete.success) {
              return { success: false, userError: complete.userError };
            }
            const tokens = await ctx.convexAuth.completeSignIn({
              providerAccountId: complete.userId,
              profile: { email: complete.email },
            });
            return { success: true, tokens };
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
            const userId = await ctx.runQuery(
              component.verifiedEmails.getUserIdByEmail,
              {
                email,
              },
            );
            if (userId === null) {
              return { success: false, userError: { error: "USER_NOT_FOUND" } };
            }

            const verifyResult = await ctx.runMutation(
              passwordComponent.public.verifyPassword,
              { userId, password },
            );
            if (!verifyResult.success) {
              return { success: false, userError: verifyResult.userError };
            }

            const tokens = await ctx.convexAuth.completeSignIn({
              providerAccountId: userId,
              profile: { email },
            });
            return { success: true, tokens };
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
            const userId = await sessionUserId(ctx);
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

            const setResult = await ctx.runMutation(
              passwordComponent.public.setPassword,
              { userId, password: newPassword },
            );
            if (!setResult.success) {
              return { success: false, userError: setResult.userError };
            }

            const to = await primaryEmail(ctx, userId);
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
            const userId = await sessionUserId(ctx);
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

            const start = await ctx.runMutation(component.challenge.start, {
              email: newEmail,
              purpose: { kind: "addEmail", userId, setPrimary: true },
              url: urls.changeEmail,
              emailSender: await senderConfig(),
            });
            if (!start.success) {
              return { success: false, userError: start.userError };
            }
            return { success: true, secret: start.secret };
          },
        }),

        /**
         * Complete an email change: validate the new address, replace the old
         * primary, and notify the old address (ASVS 6.3.7). No session is
         * minted — the user already has one.
         */
        completeChangeEmail: authMutation({
          args: { code: v.string(), secret: v.string() },
          returns: completeChangeEmailResult,
          handler: async (
            ctx,
            { code, secret },
          ): Promise<CompleteChangeEmailResult> => {
            const complete = await ctx.runMutation(
              component.challenge.complete,
              { code, secret, purpose: "addEmail" },
            );
            if (!complete.success) {
              return { success: false, userError: complete.userError };
            }
            if (complete.previousPrimaryEmail !== null) {
              await notify(
                ctx,
                complete.previousPrimaryEmail,
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
         * verified email address.
         *
         * `EMAIL_NOT_FOUND` is surfaced to the caller. This reveals whether an
         * address has an account, which sign-up's `EMAIL_TAKEN` reveals
         * anyway; the recipe accepts that trade-off for a clearer flow.
         */
        startRecovery: authMutation({
          args: { email: v.string() },
          returns: startRecoveryResult,
          handler: async (ctx, { email }): Promise<StartRecoveryResult> => {
            const check = await ctx.runMutation(
              component.challenge.checkStart,
              { email },
            );
            if (!check.ok) {
              return {
                success: false,
                userError: {
                  error: "RATE_LIMITED",
                  retryAfterMs: check.retryAfterMs,
                },
              };
            }

            const start = await ctx.runMutation(component.challenge.start, {
              email,
              purpose: { kind: "passwordReset" },
              url: urls.recovery,
              emailSender: await senderConfig(),
            });
            if (!start.success) {
              return { success: false, userError: start.userError };
            }
            return { success: true, secret: start.secret };
          },
        }),

        /**
         * Complete a password recovery: the link code + browser secret prove
         * ownership of the email, so set the new password and sign the user
         * in, in one transaction. Notifies the primary email (ASVS 6.3.7).
         *
         * Setting the password here deliberately bypasses `verifyPassword`'s
         * rate limit: the proof is the emailed link, not a password attempt.
         */
        completeRecovery: authMutation({
          args: {
            code: v.string(),
            secret: v.string(),
            newPassword: v.string(),
          },
          returns: completeRecoveryResult,
          handler: async (
            ctx,
            { code, secret, newPassword },
          ): Promise<CompleteRecoveryResult> => {
            // Validate the password before claiming the one-shot link, so a
            // format error does not burn the link.
            const passwordError = validatePasswordInputFormat(newPassword);
            if (passwordError !== null) {
              return { success: false, userError: passwordError };
            }

            const complete = await ctx.runMutation(
              component.challenge.complete,
              { code, secret, purpose: "passwordReset" },
            );
            if (!complete.success) {
              return { success: false, userError: complete.userError };
            }

            const setResult = await ctx.runMutation(
              passwordComponent.public.setPassword,
              { userId: complete.userId, password: newPassword },
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
              providerAccountId: complete.userId,
              profile: { email: complete.email },
            });

            const to = await primaryEmail(ctx, complete.userId);
            if (to !== null) {
              await notify(
                ctx,
                to,
                PASSWORD_CHANGED_SUBJECT,
                PASSWORD_CHANGED_TEXT,
              );
            }
            return { success: true, tokens };
          },
        }),

        /**
         * Report the state of a challenge (sign-up, change-email or
         * recovery) without claiming it. Landing pages call this to show what
         * the link will do before the user confirms.
         */
        getChallengeStatus: queryGeneric({
          args: { code: v.string(), secret: v.string() },
          returns: vChallengeStatus,
          handler: async (ctx, args): Promise<ChallengeStatus> => {
            return await ctx.runQuery(component.challenge.getStatus, args);
          },
        }),
      };
    },
  };
}
