/**
 * React client for the TOTP second factor, exported at
 * `@convex-dev/auth/totp/react`.
 *
 * A sign-in that a provider holds for a TOTP code comes back `incomplete`
 * with an attempt token. The client verifies a code for that attempt with
 * {@link useVerifyTotpForSignIn}, then finishes the sign-in with
 * `useContinueSignIn` from `@convex-dev/auth/react`.
 *
 * @module
 */
"use client";

import type { FunctionReference } from "convex/server";
import { useMutation } from "convex/react";
import { useCallback, useState } from "react";
import type {
  VerifyTotpForSignInArgs,
  VerifyTotpForSignInResult,
} from "./setup.ts";

/**
 * The `verifyTotpForSignIn` mutation the app exports from its `setupTotp`.
 */
export type VerifyTotpForSignInMutation = FunctionReference<
  "mutation",
  "public",
  VerifyTotpForSignInArgs,
  VerifyTotpForSignInResult
>;

/**
 * The result of the `verify` callback from {@link useVerifyTotpForSignIn}:
 * the mutation's own result, or `OTHER_ERROR` when the call threw, with the
 * thrown value on `cause`.
 */
export type VerifyTotpForSignInHookResult =
  | VerifyTotpForSignInResult
  | {
      success: false;
      userError: { error: "OTHER_ERROR"; cause: unknown };
    };

/**
 * Client for the TOTP step of a held sign-in: wire the app's
 * `verifyTotpForSignIn` mutation.
 *
 * Unlike a sign-in hook this one mints nothing, so it runs on the regular
 * Convex client rather than the sign-in API: the result carries no tokens,
 * and under SSR nothing needs to reach a cookie.
 *
 * ```tsx
 * import { useVerifyTotpForSignIn } from "@convex-dev/auth/totp/react";
 * import { useContinueSignIn } from "@convex-dev/auth/react";
 * import { api } from "../convex/_generated/api";
 *
 * function CodePrompt({ attemptToken }: { attemptToken: string }) {
 *   const { verify, pending } = useVerifyTotpForSignIn(api.auth.verifyTotpForSignIn);
 *   const { continueSignIn } = useContinueSignIn(api.auth.continueSignIn);
 *   return (
 *     <form
 *       onSubmit={async (e) => {
 *         e.preventDefault();
 *         const verified = await verify({ attemptToken, code });
 *         if (!verified.success) {
 *           // INVALID_CODE and RATE_LIMITED leave the attempt open for
 *           // another try; SIGN_IN_EXPIRED sends the user back to the
 *           // password form
 *           return;
 *         }
 *         await continueSignIn({ attemptToken });
 *       }}
 *     >
 *       <button disabled={pending}>Verify</button>
 *     </form>
 *   );
 * }
 * ```
 *
 * @param verifyMutation The app's `verifyTotpForSignIn` mutation reference.
 */
export function useVerifyTotpForSignIn(
  verifyMutation: VerifyTotpForSignInMutation,
) {
  const run = useMutation(verifyMutation);
  const [pending, setPending] = useState(false);

  const verify = useCallback(
    async (
      args: VerifyTotpForSignInArgs,
    ): Promise<VerifyTotpForSignInHookResult> => {
      setPending(true);
      try {
        return await run(args);
      } catch (cause) {
        // Folded into the result like the sign-in hooks do, so a caller
        // handles every failure through one `userError` switch.
        return { success: false, userError: { error: "OTHER_ERROR", cause } };
      } finally {
        setPending(false);
      }
    },
    [run],
  );

  return {
    /**
     * Verifies the code for the attempt. On `success` the sign-in's TOTP
     * requirement is met; continue the sign-in with `useContinueSignIn`.
     * Pass `kind: "backup"` when the user typed a backup code.
     */
    verify,
    /** `true` while the code is being verified. */
    pending,
  };
}
