/**
 * The TOTP second factor as a sign-in requirement, for providers to park a
 * sign-in on.
 *
 * The requirement's name is this component's, not the provider's: the client
 * step that satisfies it (asking for an authenticator code and calling
 * `verifyTotpForSignIn`) is the same whichever provider held the sign-in, and
 * it finds the step by this name in the `requirements` of an incomplete
 * sign-in result. Every provider that asks for a second factor parks its
 * sign-in on {@link totpSignInCheck}, so the client sees one name for it.
 *
 * @module
 */
import { v } from "convex/values";
import type { SignInCheck } from "../../lib/types.ts";
import type { ComponentApi } from "./_generated/component.ts";

/**
 * The name TOTP reports itself under in the `requirements` of an incomplete
 * sign-in.
 */
export const TOTP_REQUIREMENT = "totp";
export type TotpRequirement = typeof TOTP_REQUIREMENT;

/**
 * The {@link TOTP_REQUIREMENT} name as a validator, for a provider's
 * `vSignInIncomplete` arm.
 */
export const vTotpRequirement = v.literal(TOTP_REQUIREMENT);

/**
 * The sign-in check a provider parks a sign-in on to require a TOTP code
 * from enrolled users: the mounted component's `checkSignIn`, under the
 * {@link TOTP_REQUIREMENT} name.
 *
 * Pass it among the `checks` of the core's `deferSignIn` helper. The core
 * runs the check each time the client continues the sign-in, and reports
 * the name while an enrolled user's attempt has not verified a code.
 */
export function totpSignInCheck(
  component: ComponentApi,
): SignInCheck<TotpRequirement> {
  return {
    requirement: TOTP_REQUIREMENT,
    check: component.verification.checkSignIn,
  };
}
