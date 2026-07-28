/**
 * React client for the OAuth providers, exported at
 * `@convex-dev/auth/providers/oauth/react`.
 *
 * OAuth is registered automatically by `ConvexAuthProvider`, so there's
 * nothing to wire up. Each supported provider ships a hook that picks its
 * sign-in functions off the module you hand it (usually the generated
 * `api.auth`, whose exports the provider's catalog named statically), and
 * {@link useOauth} carries the state that isn't tied to one provider:
 *
 * ```tsx
 * const { signInGoogle } = useSignInWithGoogle(api.auth);
 * const { flowError } = useOauth();
 * await signInGoogle();
 * ```
 *
 * Apps that re-exported the functions under other names pass them explicitly:
 * `useSignInWithGoogle({ startSignInGoogle: api.auth.begin, completeSignInGoogle: api.auth.finish })`.
 *
 * The flow logic lives in `./client` and is framework-agnostic; these hooks
 * just hand it references and read what the setup registered in the auth
 * client's store.
 *
 * @module
 */
"use client";

import { getFunctionName } from "convex/server";
import { useMemo } from "react";
import { useAuthClientValue } from "../react/providers";
import {
  OAUTH_ACTIONS_STORE_KEY,
  OAUTH_FLOW_ERROR_STORE_KEY,
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

/** What every hook here throws when the OAuth setup isn't in the store. */
const NOT_REGISTERED_ERROR =
  "No OAuth setup is registered. It's registered automatically; if you " +
  "set ConvexAuthProvider's `use` prop, include oauth() in it.";

/** What {@link useOauth} returns. */
export type UseOauthReturn = {
  /**
   * Why the last sign-in attempt failed, or `null`. Cleared on the next
   * sign-in. See {@link OauthFlowError}; the app owns the user-facing
   * message for each `code`; `message` is a default only.
   */
  flowError: OauthFlowError | null;
};

/**
 * Read OAuth state that isn't tied to one provider. Completion runs on
 * whatever page a flow lands on, so `flowError` can appear on a page that
 * never calls a sign-in hook; an app-level error banner reads it from here
 * without needing any provider's function references.
 */
export function useOauth(): UseOauthReturn {
  const flowError = useAuthClientValue<OauthFlowError | null>(
    OAUTH_FLOW_ERROR_STORE_KEY,
  );
  const result = useMemo(
    () => (flowError === undefined ? undefined : { flowError }),
    [flowError],
  );
  // The store is seeded at setup, so `undefined` means oauth() was never
  // registered.
  if (result === undefined) {
    throw new Error(NOT_REGISTERED_ERROR);
  }
  return result;
}

/** What {@link useOauthSignIn} returns. */
export type UseOauthSignInReturn = {
  /**
   * Start the provider's OAuth flow (or, with `options.code`, complete one
   * begun out-of-band). Navigates away to the identity provider, except in
   * React Native, where the returned `redirect` URL should be opened in an
   * in-app browser (see {@link SignInOptions}).
   */
  signIn: (options?: SignInOptions) => Promise<SignInOutcome>;
};

/**
 * Run one OAuth provider's sign-in flow from its function references. The
 * per-provider hooks ({@link useSignInWithGoogle}) delegate here with their
 * references statically picked; reach for this directly only for a provider
 * without a shipped hook. Failures surface through {@link useOauth}'s
 * `flowError`.
 */
export function useOauthSignIn(refs: OauthProviderRefs): UseOauthSignInReturn {
  const actions = useAuthClientValue<OauthActions>(OAUTH_ACTIONS_STORE_KEY);
  // Generated api objects may mint a fresh reference object per property
  // access, so depend on the stable function *paths* (and memoize
  // unconditionally, before the not-registered throw below) to keep `signIn`'s
  // identity stable across renders.
  const startPath = getFunctionName(refs.startSignIn);
  const completePath = getFunctionName(refs.completeSignIn);
  const { providerName } = refs;
  const signIn = useMemo(() => {
    if (actions === undefined) {
      return undefined;
    }
    const stableRefs: OauthProviderRefs = {
      providerName,
      startSignIn: refs.startSignIn,
      completeSignIn: refs.completeSignIn,
    };
    return (options?: SignInOptions): Promise<SignInOutcome> =>
      actions.signIn(stableRefs, options);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [actions, providerName, startPath, completePath]);
  const result = useMemo(
    () => (signIn === undefined ? undefined : { signIn }),
    [signIn],
  );
  if (result === undefined) {
    throw new Error(NOT_REGISTERED_ERROR);
  }
  return result;
}

/** What {@link useSignInWithGoogle} returns. */
export type UseSignInWithGoogleReturn = {
  /** Start Google's OAuth flow; see {@link UseOauthSignInReturn.signIn}. */
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
  return useMemo(() => ({ signInGoogle: signIn }), [signIn]);
}

/** What {@link useSignInWithGithub} returns. */
export type UseSignInWithGithubReturn = {
  /** Start GitHub's OAuth flow; see {@link UseOauthSignInReturn.signIn}. */
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
  return useMemo(() => ({ signInGithub: signIn }), [signIn]);
}
