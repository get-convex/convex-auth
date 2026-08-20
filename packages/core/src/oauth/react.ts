/**
 * React client for the OAuth providers, exported at
 * `@convex-dev/auth/providers/oauth/react`.
 *
 * OAuth is registered by default in `ConvexAuthProvider`. Each supported
 * provider ships a hook that reads its sign-in functions from the module you
 * pass in, usually the generated `api.auth`. {@link useOauth} returns the
 * state that isn't tied to one provider.
 *
 * ```tsx
 * const { signInGoogle } = useSignInWithGoogle(api.auth);
 * const { flowError } = useOauth();
 * await signInGoogle();
 * ```
 *
 * Apps that re-exported the functions under other names pass them explicitly.
 * `useSignInWithGoogle({ startSignInGoogle: api.auth.begin, completeSignInGoogle: api.auth.finish })`
 *
 * @module
 */
"use client";

import { getFunctionName } from "convex/server";
import { useMemo } from "react";
import { useAmbientSignInValue } from "../react/providers";
import {
  OAUTH_ACTIONS_KEY,
  OAUTH_FLOW_ERROR_KEY,
  OAUTH_SETUP_ID,
  type OauthActions,
  type OauthFlowError,
  type OauthProviderApi,
  type OauthProviderRefs,
  type SignInOptions,
  type SignInOutcome,
} from "./client";

export { oauth } from "./client";
export type {
  OauthActions,
  OauthFlowError,
  OauthFlowErrorCode,
  OauthProviderApi,
  OauthProviderRefs,
  SignInOptions,
  SignInOutcome,
} from "./client";

/** What every hook here throws when the OAuth setup published nothing. */
const NOT_REGISTERED_ERROR =
  "No OAuth setup is registered. ConvexAuthProvider registers oauth() from " +
  "@convex-dev/auth/providers/oauth/react by default, so include it yourself " +
  "if you set the `ambientSignIns` prop. OAuth isn't supported under " +
  "ConvexAuthNextjsProvider yet.";

/** What {@link useOauth} returns. */
export type UseOauthReturn = {
  /**
   * Why the last sign-in attempt failed, or `null`. Cleared on the next
   * sign-in. Your app supplies the message text for each `code`.
   */
  flowError: OauthFlowError | null;
};

/**
 * Read OAuth state that isn't tied to one provider. A flow completes on
 * whichever page it redirects back to, so `flowError` can appear on a page
 * that never calls a sign-in hook. An app-level error banner can read it
 * here without any provider's function references.
 */
export function useOauth(): UseOauthReturn {
  const flowError = useAmbientSignInValue<OauthFlowError | null>(
    OAUTH_SETUP_ID,
    OAUTH_FLOW_ERROR_KEY,
  );
  // The value is published at setup, so `undefined` means oauth() was never
  // registered.
  if (flowError === undefined) {
    throw new Error(NOT_REGISTERED_ERROR);
  }
  return { flowError };
}

/** What {@link useOauthSignIn} returns. */
export type UseOauthSignInReturn = {
  /**
   * Start the provider's OAuth flow (or, with `options.code`, complete one
   * started elsewhere). Navigates away to the identity provider on the web.
   * React Native isn't supported yet. It gets the `redirect` URL back to open
   * in an in-app browser, but `options.redirectTo` is required there and can
   * only be an http or https URL (see {@link SignInOptions}).
   */
  signIn: (options?: SignInOptions) => Promise<SignInOutcome>;
};

/**
 * Run one OAuth provider's sign-in flow from its function references. The
 * per-provider hooks like {@link useSignInWithGoogle} call this with their
 * own references.
 *
 * A failure while starting the flow rejects the returned promise. After the
 * redirect back there is no caller left to catch anything, so failures from
 * then on are reported through {@link useOauth}'s `flowError` instead.
 */
export function useOauthSignIn(refs: OauthProviderRefs): UseOauthSignInReturn {
  const actions = useAmbientSignInValue<OauthActions>(
    OAUTH_SETUP_ID,
    OAUTH_ACTIONS_KEY,
  );
  // Generated api objects create a fresh reference object on every property
  // access, so the memo depends on the function paths instead. The `refs` it
  // captures can then be from an earlier render, which is fine because the
  // deps cover all three of its fields.
  const startPath = getFunctionName(refs.startSignIn);
  const completePath = getFunctionName(refs.completeSignIn);
  const { providerName } = refs;
  const signIn = useMemo(() => {
    if (actions === undefined) {
      throw new Error(NOT_REGISTERED_ERROR);
    }
    return (options?: SignInOptions): Promise<SignInOutcome> =>
      actions.signIn(refs, options);
  }, [actions, providerName, startPath, completePath]);
  return { signIn };
}

/** What {@link useSignInWithGoogle} returns. */
export type UseSignInWithGoogleReturn = {
  /** Start Google's OAuth flow. See {@link UseOauthSignInReturn.signIn}. */
  signInGoogle: UseOauthSignInReturn["signIn"];
};

/**
 * Sign in with Google. Pass the module exporting the provider's functions
 * (usually the generated `api.auth`), or an object mapping the canonical keys
 * to renamed exports.
 */
export function useSignInWithGoogle(api: {
  startSignInGoogle: OauthProviderApi["startSignIn"];
  completeSignInGoogle: OauthProviderApi["completeSignIn"];
}): UseSignInWithGoogleReturn {
  const { signIn } = useOauthSignIn({
    providerName: "google",
    startSignIn: api.startSignInGoogle,
    completeSignIn: api.completeSignInGoogle,
  });
  return { signInGoogle: signIn };
}

/** What {@link useSignInWithGithub} returns. */
export type UseSignInWithGithubReturn = {
  /** Start GitHub's OAuth flow. See {@link UseOauthSignInReturn.signIn}. */
  signInGithub: UseOauthSignInReturn["signIn"];
};

/**
 * Sign in with GitHub. Pass the module exporting the provider's functions
 * (usually the generated `api.auth`), or an object mapping the canonical keys
 * to renamed exports.
 */
export function useSignInWithGithub(api: {
  startSignInGithub: OauthProviderApi["startSignIn"];
  completeSignInGithub: OauthProviderApi["completeSignIn"];
}): UseSignInWithGithubReturn {
  const { signIn } = useOauthSignIn({
    providerName: "github",
    startSignIn: api.startSignInGithub,
    completeSignIn: api.completeSignInGithub,
  });
  return { signInGithub: signIn };
}
