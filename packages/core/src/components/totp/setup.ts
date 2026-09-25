/**
 * The app-facing functions of the TOTP second factor.
 *
 * ```ts
 * // convex/auth.ts
 * export const { verifyTotpForSignIn } = setupTotp(core, {
 *   component: components.authTotp,
 * });
 * ```
 *
 * A provider that asks enrolled users for a code (see the `totp` option of
 * `setupUsernamePassword`) holds the sign-in and hands the client an attempt
 * token. The client verifies a code here, against the user the attempt names,
 * and then finishes the sign-in with the core's `continueSignIn`, which asks
 * the TOTP component whether this attempt verified one.
 *
 * @module
 */
import { mutationGeneric } from "convex/server";
import { Infer, v } from "convex/values";
import type { AuthCore } from "../core/setup.ts";
import type { ComponentApi } from "./_generated/component.ts";
import { verifyCodeUserError } from "./validation.ts";

/** Options for {@link setupTotp}. */
export type TotpOptions = {
  /** The mounted TOTP component (`components.authTotp`). */
  component: ComponentApi;
};

/** What `code` is: an authenticator code or one of the user's backup codes. */
const codeKind = v.optional(v.union(v.literal("totp"), v.literal("backup")));

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
      v.object({ error: v.literal("NOT_ENROLLED") }),
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

/**
 * Build the TOTP functions for the app to export. See the module docs for the
 * wiring.
 */
export function setupTotp<UsersTable extends string>(
  core: AuthCore<UsersTable>,
  options: TotpOptions,
) {
  const { component } = options;

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
        kind: codeKind,
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
  };
}
