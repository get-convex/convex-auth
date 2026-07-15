import {
  actionGeneric,
  createFunctionHandle,
  FunctionReference,
  GenericDatabaseWriter,
  mutationGeneric,
} from "convex/server";
import { Infer, v } from "convex/values";
import { ProviderConfig, ProviderHelpers, vTokenBundle } from "../../lib/types";
import type { ComponentApi } from "./_generated/component.js";
import type {
  DataModelWithVerifiableEmail,
  EmailValidationOptions,
} from "../emailValidation/config";
import {
  validatePasswordInputFormat,
  setPasswordUserError,
  verifyPasswordUserError,
} from "./validation";

/**
 * Options for {@link UsernamePassword}, a discriminated union on `mode`.
 *
 * `mode` is mandatory. The two modes expose different APIs and take different
 * options, and the union makes the difference explicit rather than inferring it
 * from the presence of a setting:
 *
 * - `"username"`: accounts are `(username, password)` pairs, no email.
 * - `"email"`: accounts are keyed by a verified email address; requires the
 *   `emailValidation` config (see `emailValidation()` from
 *   `@convex-dev/auth/providers/emailValidation/setup`).
 */
export type UsernameModeOptions = {
  mode: "username";
  /**
   * The mounted password component (`components.authPasswordProvider`). The
   * recipe drives its `setPassword` / `verifyPassword` mutations.
   */
  component: ComponentApi;
};
export type EmailModeOptions = {
  mode: "email";
  /**
   * The mounted password component (`components.authPasswordProvider`).
   */
  component: ComponentApi;
  /**
   * Email-validation config, produced by `emailValidation<DataModel>({ ... })`.
   * Mandatory in email mode: sign-up sends a confirmation code and only mints a
   * session once it is confirmed.
   */
  emailValidation: EmailValidationOptions;
};
export type UsernamePasswordOptions = UsernameModeOptions | EmailModeOptions;

// TODO: derive this from the component mount path rather than hardcoding it.
const PROVIDER_NAME = "password";

// Used to compare usernames case-insensitively.
function normalizeUsername(username: string): string {
  return username.toLowerCase();
}

// Used to compare emails case-insensitively; also trims surrounding whitespace.
function normalizeEmail(email: string): string {
  return email.trim().toLowerCase();
}

// --- Username-mode API -----------------------------------------------------

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
type SignInResult = Infer<typeof signInResult>;

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
type SignUpResult = Infer<typeof signUpResult>;

/**
 * Build the username-mode API: every account is a `(username, password)` pair,
 * with no email or email verification.
 *
 * Account resolution (username → app user id) is owned by the core's `accounts`
 * table: the recipe uses the lowercased username as the provider account id, and
 * looks it up with the `resolveUserId` helper the core supplies. The password
 * component itself stores only `{ userId, passwordHash }` and knows nothing about
 * usernames.
 */
function buildUsernamePasswordApi(
  { completeSignIn, resolveUserId }: ProviderHelpers,
  options: UsernameModeOptions,
) {
  const { component } = options;
  return {
    /**
     * Create a new account: reject a taken username or an invalid password,
     * otherwise create the user + session and store the password.
     */
    signUpWithPassword: actionGeneric({
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

        const setResult = await ctx.runMutation(component.public.setPassword, {
          userId: tokens.userId,
          password,
        });
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
    signInWithPassword: actionGeneric({
      args: { username: v.string(), password: v.string() },
      returns: signInResult,
      handler: async (ctx, { username, password }): Promise<SignInResult> => {
        const id = normalizeUsername(username);
        const userId = await resolveUserId(ctx, id);
        if (userId === null) {
          return { success: false, userError: { error: "USER_NOT_FOUND" } };
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
}

// --- Email-mode API --------------------------------------------------------

const emailSignUpResult = v.union(
  v.object({
    success: v.literal(true),
    // The client-held `<id>.<secret>` string. Pass it back to `confirmEmail`
    // together with the code from the email.
    emailValidationSession: v.string(),
  }),
  v.object({
    success: v.literal(false),
    userError: v.union(
      setPasswordUserError,
      v.object({ error: v.literal("RATE_LIMITED"), retryAfterMs: v.number() }),
    ),
  }),
);
type EmailSignUpResult = Infer<typeof emailSignUpResult>;

const confirmEmailResult = v.union(
  v.object({ success: v.literal(true), tokens: vTokenBundle }),
  v.object({
    success: v.literal(false),
    userError: v.union(
      v.object({ error: v.literal("INVALID_CODE") }),
      v.object({ error: v.literal("SESSION_EXPIRED") }),
      v.object({ error: v.literal("EMAIL_TAKEN") }),
      v.object({ error: v.literal("RATE_LIMITED"), retryAfterMs: v.number() }),
    ),
  }),
);
type ConfirmEmailResult = Infer<typeof confirmEmailResult>;

// The `FunctionReference` shape of resend's `lib.sendEmail`, used to turn the
// loosely-typed `sendEmailRef` into a handle. Only the fields we send are
// listed; resend accepts more, all optional.
type SendEmailRef = FunctionReference<
  "mutation",
  "internal",
  {
    from: string;
    to: string[];
    subject?: string;
    text?: string;
    options: {
      apiKey: string;
      testMode: boolean;
      retryAttempts: number;
      initialBackoffMs: number;
    };
  },
  string
>;

/**
 * Build the email-mode API: accounts are keyed by a verified email address. The
 * address is proven before it ever lands in the app's `users` table.
 *
 * - `signUpWithPassword` creates the app user (no email, no account, no tokens),
 *   stores the password, and emails a confirmation code, returning the session
 *   string.
 * - `confirmEmail` verifies the session + code, writes the email onto the users
 *   row, creates the account, and mints tokens.
 * - `signInWithPassword` behaves like username mode but is keyed by email; an
 *   unconfirmed user has no account yet and so resolves as `USER_NOT_FOUND`.
 */
function buildEmailPasswordApi(
  { completeSignIn, resolveUserId, createUser }: ProviderHelpers,
  options: EmailModeOptions,
) {
  const { component } = options;
  const {
    component: emailComponent,
    sendEmailRef,
    from,
  } = options.emailValidation;

  return {
    signUpWithPassword: actionGeneric({
      args: { email: v.string(), password: v.string() },
      returns: emailSignUpResult,
      handler: async (ctx, { email, password }): Promise<EmailSignUpResult> => {
        // Validate the password before creating anything.
        const userError = validatePasswordInputFormat(password);
        if (userError !== null) {
          return { success: false, userError };
        }

        const normalizedEmail = normalizeEmail(email);

        // Create the app user with an EMPTY profile: no email, no account, no
        // tokens. A duplicate sign-up for a still-pending email simply mints a
        // new users row + validation session (no enumeration-leaking early
        // check); only the confirmation step enforces email uniqueness.
        // TODO: orphaned unverified users rows accumulate — add a cleanup job.
        const userId = await createUser(ctx, {
          provider: PROVIDER_NAME,
          providerAccountId: normalizedEmail,
          profile: {},
        });

        const setResult = await ctx.runMutation(component.public.setPassword, {
          userId,
          password,
        });
        if (!setResult.success) {
          // Pre-validated above, so this should not happen. Throw so nothing
          // commits.
          throw new Error("Unexpected error when setting the password.", {
            cause: setResult.userError,
          });
        }

        // Create a validation session (rate-limited per email) and email the
        // code via the app's resend handle.
        const sendEmailHandle = await createFunctionHandle(
          sendEmailRef as SendEmailRef,
        );
        const createResult = await ctx.runMutation(
          emailComponent.public.createSession,
          {
            userId,
            email: normalizedEmail,
            send: {
              handle: sendEmailHandle,
              from,
              // `apiKey` defaults to the RESEND_API_KEY env var; `testMode`
              // defaults to true, matching resend's own default.
              apiKey:
                options.emailValidation.apiKey ??
                process.env.RESEND_API_KEY ??
                "",
              testMode: options.emailValidation.testMode ?? true,
            },
          },
        );
        if (!createResult.ok) {
          return { success: false, userError: createResult.userError };
        }

        return {
          success: true,
          emailValidationSession: createResult.session,
        };
      },
    }),

    /**
     * Confirm a pending email: consume the validation session (secret + code),
     * enforce email uniqueness, write the email onto the users row, and mint a
     * session. Runs as a mutation so it can touch the app's `users` table.
     */
    confirmEmail: mutationGeneric({
      args: { emailValidationSession: v.string(), code: v.string() },
      returns: confirmEmailResult,
      handler: async (
        ctx,
        { emailValidationSession, code },
      ): Promise<ConfirmEmailResult> => {
        const consumed = await ctx.runMutation(
          emailComponent.public.consumeSession,
          { session: emailValidationSession, code },
        );
        if (!consumed.valid) {
          switch (consumed.error) {
            case "INVALID":
              return { success: false, userError: { error: "INVALID_CODE" } };
            case "EXPIRED":
              return {
                success: false,
                userError: { error: "SESSION_EXPIRED" },
              };
            case "RATE_LIMITED":
              return {
                success: false,
                userError: {
                  error: "RATE_LIMITED",
                  retryAfterMs: consumed.retryAfterMs ?? 0,
                },
              };
          }
        }

        const { userId, email } = consumed;

        // The type-level schema gate (`DataModelWithVerifiableEmail`) guarantees
        // the app's `users` table has an optional `email` and a `by_email`
        // index, so this single cast is safe.
        const db =
          ctx.db as unknown as GenericDatabaseWriter<DataModelWithVerifiableEmail>;

        // Enforce email uniqueness across *confirmed* accounts. The pending
        // user's own row has no email yet, so any hit is a different, already
        // confirmed user.
        const taken = await db
          .query("users")
          .withIndex("by_email", (q) => q.eq("email", email))
          .first();
        if (taken !== null) {
          // The session is consumed even though we fail here — intentional: this
          // session could never succeed (the email is permanently taken), so
          // there's nothing to retry. The user must start a new sign-up.
          return { success: false, userError: { error: "EMAIL_TAKEN" } };
        }

        const usersId = db.normalizeId("users", userId);
        if (usersId === null) {
          // The user row was created at sign-up; a missing id is a programming
          // error, not a user-facing condition.
          throw new Error(`Unknown user id: ${userId}`);
        }
        await db.patch("users", usersId, { email });

        // Create the account bound to the existing (now email-bearing) user and
        // mint the session.
        const tokens = await completeSignIn(
          ctx,
          {
            provider: PROVIDER_NAME,
            providerAccountId: email,
            profile: { email },
          },
          { existingUserId: userId },
        );
        return { success: true, tokens };
      },
    }),

    signInWithPassword: actionGeneric({
      args: { email: v.string(), password: v.string() },
      returns: signInResult,
      handler: async (ctx, { email, password }): Promise<SignInResult> => {
        const id = normalizeEmail(email);
        const userId = await resolveUserId(ctx, id);
        if (userId === null) {
          // No account: either the email was never registered or the sign-up is
          // still unconfirmed (the account is only created at confirmation).
          // TODO: distinguish these for UX — an unconfirmed user should be told
          // to confirm their email / offered a resend, not "not found".
          return { success: false, userError: { error: "USER_NOT_FOUND" } };
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
          profile: { email: id },
        });
        return { success: true, tokens };
      },
    }),
  };
}

// --- Provider wiring -------------------------------------------------------

type PlainPasswordApi = ReturnType<typeof buildUsernamePasswordApi>;
type EmailPasswordApi = ReturnType<typeof buildEmailPasswordApi>;

// The API a given set of options produces, resolved from the `mode` discriminant.
type UsernamePasswordApi<O> = O extends { mode: "email" }
  ? EmailPasswordApi
  : PlainPasswordApi;

// Runtime dispatch on `mode`; the casts bridge the runtime branch to the
// conditional return type (TS can't correlate the two).
function passwordSetup<O extends UsernamePasswordOptions>(
  helpers: ProviderHelpers,
  options: O,
): UsernamePasswordApi<O> {
  if (options.mode === "email") {
    return buildEmailPasswordApi(helpers, options) as UsernamePasswordApi<O>;
  }
  return buildUsernamePasswordApi(helpers, options) as UsernamePasswordApi<O>;
}

/**
 * The username+password provider (name `"password"`), supporting two modes:
 *
 * - **Username mode** — wire it with `provider()`:
 *   ```ts
 *   provider(UsernamePassword, { mode: "username", component: components.authPasswordProvider })
 *   ```
 * - **Email mode** — wire it with `UsernamePassword.withOptions()` (required so
 *   the returned API is resolved to the email API from the concrete options):
 *   ```ts
 *   UsernamePassword.withOptions({
 *     mode: "email",
 *     component: components.authPasswordProvider,
 *     emailValidation: emailValidation<DataModel>({
 *       component: components.authEmailValidation,
 *       resend: components.resend,
 *       from: "My App <auth@example.com>",
 *     }),
 *   })
 *   ```
 *
 * Passing `mode: "email"` through `provider()` is a compile error rather than a
 * silently wrong API: `provider()` sees the base config, typed for username
 * mode. `defineProvider` isn't used here because it collapses the generic setup.
 */
export const UsernamePassword: ProviderConfig<
  "password",
  UsernameModeOptions,
  PlainPasswordApi
> & {
  /**
   * Wire the provider with concrete options, resolving the returned API from
   * the options' `mode`. Returns the `[config, options]` tuple `setupCore`
   * expects. Use this for email mode; username mode can use `provider()` too.
   */
  withOptions: <O extends UsernamePasswordOptions>(
    options: O,
  ) => readonly [ProviderConfig<"password", O, UsernamePasswordApi<O>>, O];
} = {
  name: PROVIDER_NAME,
  setup: (helpers, options) => buildUsernamePasswordApi(helpers, options),
  withOptions: <O extends UsernamePasswordOptions>(options: O) =>
    [
      {
        name: PROVIDER_NAME,
        setup: (helpers: ProviderHelpers, opts: O) =>
          passwordSetup(helpers, opts),
      },
      options,
    ] as const,
};
