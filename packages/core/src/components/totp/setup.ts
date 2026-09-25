/**
 * The app-facing functions of the TOTP second factor: the step that
 * satisfies a held sign-in, and what a signed-in user manages their
 * authenticator with (enrolling an app, turning it off, renewing backup
 * codes).
 *
 * ```ts
 * // convex/auth.ts
 * export const {
 *   verifyTotpForSignIn,
 *   getTotpStatus,
 *   startTotpEnrollment,
 *   confirmTotpEnrollment,
 *   disableTotp,
 *   regenerateBackupCodes,
 * } = setupTotp(core, { component: components.authTotp, issuer: "Acme" });
 * ```
 *
 * A provider that asks enrolled users for a code (see the `totp` option of
 * `setupUsernamePassword`) holds the sign-in and hands the client an attempt
 * token. The client verifies a code with `verifyTotpForSignIn`, against the
 * user the attempt names, and then finishes the sign-in with the core's
 * `continueSignIn`, which asks the TOTP component whether this attempt
 * verified one.
 *
 * The management functions act on the caller's own user id, read from the
 * access token, so a client can only ever manage its own second factor. What
 * they enroll is what the sign-in step checks codes against. The changes that
 * weaken the factor, `disableTotp` and `regenerateBackupCodes`, take a
 * current code, which the component itself demands: these functions only
 * say whose code it is.
 *
 * @module
 */
import { mutationGeneric, queryGeneric } from "convex/server";
import { Infer, v } from "convex/values";
import { getAuthUserId } from "../core/userId.ts";
import type { AuthCore } from "../core/setup.ts";
import type { ComponentApi } from "./_generated/component.ts";
import { assertValidIssuer } from "./totp.ts";
import {
  codeKind,
  confirmTotpUserError,
  secondFactorUserError,
  verifyCodeUserError,
} from "./validation.ts";

/** Options for {@link setupTotp}. */
export type TotpOptions = {
  /** The mounted TOTP component (`components.authTotp`). */
  component: ComponentApi;
  /**
   * The name of the application, shown next to the account in the user's
   * authenticator app. It must not contain a colon.
   */
  issuer: string;
};

const notSignedInUserError = v.object({ error: v.literal("NOT_SIGNED_IN") });
const notEnrolledUserError = v.object({ error: v.literal("NOT_ENROLLED") });

// What `code` is, for the changes to the factor that demand one: an
// authenticator code (the default) or one of the user's backup codes.
const optionalCodeKind = v.optional(codeKind);

// How a signed-in user's change to the second factor fails: the component's
// own errors (a wrong code, the rate limit, no factor to change), or no
// session.
const manageSecondFactorUserError = v.union(
  secondFactorUserError,
  notSignedInUserError,
);

const verifyTotpForSignInResult = v.union(
  v.object({
    success: v.literal(true),
    // Set when a backup code was verified: how many the user has left. An
    // app warns the user when this gets low.
    remainingBackupCodes: v.optional(v.number()),
  }),
  v.object({
    success: v.literal(false),
    userError: v.union(
      verifyCodeUserError,
      // The attempt token is unknown, expired, superseded, or already spent.
      // The user starts the sign-in over.
      v.object({ error: v.literal("SIGN_IN_EXPIRED") }),
      // The user behind the attempt has no active authenticator, so there is
      // no code to verify: the sign-in owes nothing here and the client
      // continues it as it is.
      notEnrolledUserError,
    ),
  }),
);

/**
 * The result of `verifyTotpForSignIn`.
 *
 * On success the sign-in's TOTP requirement is met (and, after a backup code,
 * how many backup codes remain); the client continues the sign-in with the
 * core's `continueSignIn`. Otherwise a user-facing `userError`.
 */
export type VerifyTotpForSignInResult = Infer<typeof verifyTotpForSignInResult>;

/** The arguments of `verifyTotpForSignIn`. */
export type VerifyTotpForSignInArgs = {
  /** The `attemptToken` of the incomplete sign-in result. */
  attemptToken: string;
  /** The code, as the user typed it. */
  code: string;
  /**
   * What `code` is: a code from the authenticator app (`"totp"`, the
   * default) or one of the user's backup codes (`"backup"`).
   */
  kind?: "totp" | "backup";
};

const totpStatusResult = v.union(
  v.object({
    // `true` when the user has an active authenticator, thus gives a code at
    // sign-in.
    enabled: v.boolean(),
    remainingBackupCodes: v.number(),
  }),
  v.null(),
);

/** The result of `getTotpStatus`: the user's status, or `null` when signed out. */
export type TotpStatusResult = Infer<typeof totpStatusResult>;

const startTotpEnrollmentResult = v.union(
  v.object({
    success: v.literal(true),
    // The base32 secret, for a user who types it into the authenticator app.
    secret: v.string(),
    // The `otpauth://` URI, for a QR code the authenticator app scans.
    otpauthUri: v.string(),
  }),
  v.object({ success: v.literal(false), userError: notSignedInUserError }),
);

/** The result of `startTotpEnrollment`. */
export type StartTotpEnrollmentResult = Infer<typeof startTotpEnrollmentResult>;

const confirmTotpEnrollmentResult = v.union(
  v.object({
    success: v.literal(true),
    // The user's new backup codes, shown this once. The component stores
    // only their hashes.
    backupCodes: v.array(v.string()),
  }),
  v.object({
    success: v.literal(false),
    userError: v.union(confirmTotpUserError, notSignedInUserError),
  }),
);

/** The result of `confirmTotpEnrollment`. */
export type ConfirmTotpEnrollmentResult = Infer<
  typeof confirmTotpEnrollmentResult
>;

const disableTotpResult = v.union(
  v.object({ success: v.literal(true) }),
  v.object({
    success: v.literal(false),
    userError: manageSecondFactorUserError,
  }),
);

/** The result of `disableTotp`. */
export type DisableTotpResult = Infer<typeof disableTotpResult>;

const regenerateBackupCodesResult = v.union(
  v.object({ success: v.literal(true), backupCodes: v.array(v.string()) }),
  v.object({
    success: v.literal(false),
    userError: manageSecondFactorUserError,
  }),
);

/** The result of `regenerateBackupCodes`. */
export type RegenerateBackupCodesResult = Infer<
  typeof regenerateBackupCodesResult
>;

/**
 * Build the TOTP functions for the app to export. See the module docs for the
 * wiring.
 */
export function setupTotp<UsersTable extends string>(
  core: AuthCore<UsersTable>,
  options: TotpOptions,
) {
  const { component, issuer } = options;
  assertValidIssuer(issuer);

  return {
    /**
     * Verify a code for a sign-in that a provider held for one, so the core's
     * `continueSignIn` can finish it.
     *
     * The code is checked against the user the attempt token resolves to,
     * never against a caller-supplied identity, and a verified code is
     * recorded for *this* attempt: the TOTP component's check, which the
     * provider parked the sign-in with, reports the requirement met from then
     * on. Pass `kind: "backup"` for one of the user's backup codes.
     *
     * The code's own errors (`INVALID_CODE`, `RATE_LIMITED`) leave the attempt
     * in place for another try, within the attempt's lifetime.
     * `SIGN_IN_EXPIRED` means the attempt is gone and the user starts over.
     */
    verifyTotpForSignIn: mutationGeneric({
      args: {
        attemptToken: v.string(),
        code: v.string(),
        kind: optionalCodeKind,
      },
      returns: verifyTotpForSignInResult,
      handler: async (
        ctx,
        { attemptToken, code, kind },
      ): Promise<VerifyTotpForSignInResult> => {
        const pending = await core.getPendingSignIn(ctx, attemptToken);
        if (pending === null) {
          return { success: false, userError: { error: "SIGN_IN_EXPIRED" } };
        }
        const { userId, attemptId } = pending;

        // `verifyCode` throws for a user with no active secret, since a
        // flow that asks for a code is expected to know. Here the attempt is
        // the client's word that a code is owed, so check first.
        const status = await ctx.runQuery(component.enrollment.getStatus, {
          userId,
        });
        if (!status.enabled) {
          return { success: false, userError: { error: "NOT_ENROLLED" } };
        }

        if (kind === "backup") {
          const result = await ctx.runMutation(
            component.verification.verifyBackupCode,
            { userId, code, attemptId },
          );
          if (!result.success) {
            return { success: false, userError: result.userError };
          }
          return {
            success: true,
            remainingBackupCodes: result.remainingBackupCodes,
          };
        }
        const result = await ctx.runMutation(
          component.verification.verifyCode,
          {
            userId,
            code,
            attemptId,
          },
        );
        if (!result.success) {
          return { success: false, userError: result.userError };
        }
        return { success: true };
      },
    }),

    /**
     * The signed-in user's TOTP status: whether a code is required of them
     * at sign-in, whether an enrollment awaits confirmation, and how many
     * backup codes they have left. `null` for a signed-out caller.
     */
    getTotpStatus: queryGeneric({
      args: {},
      returns: totpStatusResult,
      handler: async (ctx): Promise<TotpStatusResult> => {
        const userId = await getAuthUserId(ctx);
        if (userId === null) return null;
        return await ctx.runQuery(component.enrollment.getStatus, { userId });
      },
    }),

    /**
     * Start enrolling an authenticator app: mint a secret for the signed-in
     * user and return it, with the `otpauth://` URI to show as a QR code.
     *
     * The secret grants nothing until `confirmTotpEnrollment` proves that
     * the authenticator has it. Starting again replaces an unconfirmed
     * secret. An authenticator the user already confirmed keeps working
     * until the new one is confirmed.
     *
     * `accountName` labels the account in the authenticator app, next to
     * the issuer: the user's username or email address, say.
     */
    startTotpEnrollment: mutationGeneric({
      args: { accountName: v.string() },
      returns: startTotpEnrollmentResult,
      handler: async (
        ctx,
        { accountName },
      ): Promise<StartTotpEnrollmentResult> => {
        const userId = await getAuthUserId(ctx);
        if (userId === null) {
          return { success: false, userError: { error: "NOT_SIGNED_IN" } };
        }
        const created = await ctx.runMutation(component.enrollment.createTotp, {
          userId,
          issuerDisplayName: issuer,
          accountDisplayName: accountName,
        });
        return { success: true, ...created };
      },
    }),

    /**
     * Finish enrolling: check a code from the authenticator against the
     * secret `startTotpEnrollment` minted, and activate it.
     *
     * On success the user owes a code at every sign-in from now on, and
     * gets a fresh set of backup codes, which replaces any previous set.
     * Show them once and tell the user to save them.
     */
    // TODO: protect enrollment with step-up auth
    // TODO: notify verifiedEmail on enrollment
    confirmTotpEnrollment: mutationGeneric({
      args: { code: v.string() },
      returns: confirmTotpEnrollmentResult,
      handler: async (ctx, { code }): Promise<ConfirmTotpEnrollmentResult> => {
        const userId = await getAuthUserId(ctx);
        if (userId === null) {
          return { success: false, userError: { error: "NOT_SIGNED_IN" } };
        }
        const result = await ctx.runMutation(component.enrollment.confirmTotp, {
          userId,
          code,
        });
        if (!result.success) {
          return { success: false, userError: result.userError };
        }
        return { success: true, backupCodes: result.backupCodes };
      },
    }),

    /**
     * Turn the second factor off for the signed-in user: delete the
     * authenticator secret and the backup codes.
     *
     * The user proves they still hold the authenticator with a current
     * code (or a backup code, with `kind: "backup"`), so a stolen session
     * alone cannot weaken the account; the component refuses without one.
     * Sign-in then takes the password alone until the user enrolls again.
     */
    // TODO: notify verifiedEmail on disable
    disableTotp: mutationGeneric({
      args: { code: v.string(), kind: optionalCodeKind },
      returns: disableTotpResult,
      handler: async (ctx, { code, kind }): Promise<DisableTotpResult> => {
        const userId = await getAuthUserId(ctx);
        if (userId === null) {
          return { success: false, userError: { error: "NOT_SIGNED_IN" } };
        }
        return await ctx.runMutation(component.management.deleteTotp, {
          userId,
          code,
          kind: kind ?? "totp",
        });
      },
    }),

    /**
     * Give the signed-in user a new set of backup codes. The previous set
     * stops working. Show the new codes once.
     *
     * As for `disableTotp`, the user proves they still hold the
     * authenticator with a current code (or one of the old backup codes,
     * with `kind: "backup"`): backup codes stand in for the authenticator at
     * sign-in, so a stolen session alone must not mint a set.
     */
    // TODO: notify verifiedEmail on regeneration
    regenerateBackupCodes: mutationGeneric({
      args: { code: v.string(), kind: optionalCodeKind },
      returns: regenerateBackupCodesResult,
      handler: async (
        ctx,
        { code, kind },
      ): Promise<RegenerateBackupCodesResult> => {
        const userId = await getAuthUserId(ctx);
        if (userId === null) {
          return { success: false, userError: { error: "NOT_SIGNED_IN" } };
        }
        return await ctx.runMutation(
          component.management.regenerateBackupCodes,
          { userId, code, kind: kind ?? "totp" },
        );
      },
    }),
  };
}
