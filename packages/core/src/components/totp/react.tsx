/**
 * React client for the TOTP second factor, exported at
 * `@convex-dev/auth/totp/react`.
 *
 * A sign-in that a provider holds for a TOTP code comes back `incomplete`,
 * and `usePendingSignIn` (from `@convex-dev/auth/react`) reports it with
 * {@link TOTP_REQUIREMENT} among its `requirements`. The app then asks for a
 * code and hands it to {@link useTotpSignInStep}, which verifies it for the
 * pending attempt and finishes the sign-in.
 *
 * @module
 */
"use client";

import type { FunctionReference } from "convex/server";
import { useMutation } from "convex/react";
import { useCallback, useState } from "react";
import type { ContinueSignInFn } from "../../lib/types.ts";
import { usePendingSignInContext } from "../../react/client.tsx";
import { useContinueSignIn } from "../../react/index.tsx";
import type {
  VerifyTotpForSignInArgs,
  VerifyTotpForSignInResult,
} from "./setup.ts";

export { TOTP_REQUIREMENT, type TotpRequirement } from "./requirement.ts";

/**
 * The `verifyTotpForSignIn` mutation the app exports from its `setupTotp`.
 */
export type VerifyTotpForSignInMutation = FunctionReference<
  "mutation",
  "public",
  VerifyTotpForSignInArgs,
  VerifyTotpForSignInResult
>;

/** What the user typed, for the `submit` callback of {@link useTotpSignInStep}. */
export type TotpSignInCode = {
  /** The code, as the user typed it. */
  code: string;
  /**
   * What `code` is: a code from the authenticator app (`"totp"`, the
   * default) or one of the user's backup codes (`"backup"`).
   */
  kind?: "totp" | "backup";
};

/**
 * The result of the `submit` callback from {@link useTotpSignInStep}.
 *
 * `complete` means the client now holds a session. `incomplete` means the
 * code was accepted but another requirement still stands: `usePendingSignIn`
 * names it, and the app renders that step next. `remainingBackupCodes` is set
 * on either when a backup code was spent: how many the user has left.
 *
 * On `error`, `INVALID_CODE` and `RATE_LIMITED` leave the attempt open for
 * another try. `SIGN_IN_EXPIRED` means the attempt is gone, and
 * `usePendingSignIn` reports `expired`. `OTHER_ERROR` is a call that threw,
 * with the thrown value on `cause`.
 */
export type TotpSignInStepResult =
  | { status: "complete"; remainingBackupCodes?: number }
  | {
      status: "incomplete";
      requirements: string[];
      remainingBackupCodes?: number;
    }
  | {
      status: "error";
      userError:
        | Extract<VerifyTotpForSignInResult, { success: false }>["userError"]
        | { error: "OTHER_ERROR"; cause: unknown };
    };

/**
 * Client for the TOTP step of a pending sign-in: verify the user's code for
 * the attempt `usePendingSignIn` holds, then continue the sign-in.
 *
 * Pass the app's `verifyTotpForSignIn` (from `setupTotp`) and
 * `continueSignIn` (from `setupCore`) mutations.
 *
 * ```tsx
 * import { useTotpSignInStep } from "@convex-dev/auth/totp/react";
 * import { api } from "../convex/_generated/api";
 *
 * function CodePrompt() {
 *   const { submit, pending } = useTotpSignInStep({
 *     verifyTotpForSignIn: api.auth.verifyTotpForSignIn,
 *     continueSignIn: api.auth.continueSignIn,
 *   });
 *   return (
 *     <form
 *       onSubmit={async (e) => {
 *         e.preventDefault();
 *         const result = await submit({ code });
 *         if (result.status === "error") {
 *           // INVALID_CODE and RATE_LIMITED: show a message and let the
 *           // user try again
 *         }
 *       }}
 *     >
 *       <button disabled={pending}>Verify</button>
 *     </form>
 *   );
 * }
 * ```
 *
 * The code is verified on the regular Convex client, since that call mints
 * nothing; continuing the sign-in runs through the sign-in API, like a
 * provider's own sign-in hook, so it works under either session model.
 */
export function useTotpSignInStep(api: {
  /** The app's `verifyTotpForSignIn` mutation reference. */
  verifyTotpForSignIn: VerifyTotpForSignInMutation;
  /** The app's `continueSignIn` mutation reference. */
  continueSignIn: ContinueSignInFn;
}) {
  const { pendingSignIn, adopt } = usePendingSignInContext();
  const verify = useMutation(api.verifyTotpForSignIn);
  const { continueSignIn } = useContinueSignIn(api.continueSignIn);
  const [pending, setPending] = useState(false);

  const submit = useCallback(
    async ({ code, kind }: TotpSignInCode): Promise<TotpSignInStepResult> => {
      if (pendingSignIn === null) {
        return { status: "error", userError: { error: "SIGN_IN_EXPIRED" } };
      }
      const { attemptToken } = pendingSignIn;
      setPending(true);
      try {
        let verified: VerifyTotpForSignInResult;
        try {
          verified = await verify({ attemptToken, code, kind });
        } catch (cause) {
          return {
            status: "error",
            userError: { error: "OTHER_ERROR", cause },
          };
        }
        if (!verified.success) {
          const failure = {
            status: "error" as const,
            userError: verified.userError,
          };
          await adopt(failure);
          return failure;
        }
        const { remainingBackupCodes } = verified;
        const result = await continueSignIn({ attemptToken });
        switch (result.status) {
          case "complete":
            return { status: "complete", remainingBackupCodes };
          case "incomplete":
            return {
              status: "incomplete",
              requirements: result.requirements,
              remainingBackupCodes,
            };
          default:
            return result;
        }
      } finally {
        setPending(false);
      }
    },
    [pendingSignIn, verify, continueSignIn, adopt],
  );

  return {
    /**
     * Verifies the code for the pending sign-in and, once it is accepted,
     * continues the sign-in. See {@link TotpSignInStepResult}.
     */
    submit,
    /** `true` while the code is being verified or the sign-in continued. */
    pending,
  };
}
