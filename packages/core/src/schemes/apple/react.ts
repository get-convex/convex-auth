/**
 * React client for the Apple sign-in scheme, exported at
 * `@convex-dev/auth/schemes/apple/react`.
 *
 * {@link useSignInWithApple} starts the sign-in. {@link useOauth} returns the
 * state that is shared by all the OAuth schemes, for example the error of the
 * last flow.
 *
 * ```tsx
 * const { signInApple } = useSignInWithApple(api.auth);
 * const { flowError } = useOauth();
 * ```
 *
 * @module
 */
"use client";

import type { OauthProviderApi } from "../oauth/client.ts";
import { useOauthSignIn, type UseOauthSignInReturn } from "../oauth/react.ts";

export { useOauth, type UseOauthReturn } from "../oauth/react.ts";
export type {
  OauthCompleteResult,
  OauthFlowError,
  OauthStartResult,
  SignInOptions,
} from "../oauth/client.ts";

/** What {@link useSignInWithApple} returns. */
export type UseSignInWithAppleReturn = {
  /** Start Apple's OAuth flow. See {@link UseOauthSignInReturn.signIn}. */
  signInApple: UseOauthSignInReturn["signIn"];
};

/**
 * Sign in with Apple. Pass the module exporting the provider's functions
 * (usually the generated `api.auth`), or an object mapping the canonical keys
 * to renamed exports.
 */
export function useSignInWithApple(api: {
  startSignInApple: OauthProviderApi["startSignIn"];
  completeSignInApple: OauthProviderApi["completeSignIn"];
}): UseSignInWithAppleReturn {
  const { signIn } = useOauthSignIn({
    providerName: "apple",
    startSignIn: api.startSignInApple,
    completeSignIn: api.completeSignInApple,
  });
  return { signInApple: signIn };
}
