/**
 * React hooks for the OAuth providers, exported at
 * `@convex-dev/auth/providers/oauth/react`.
 *
 * Each supported provider ships a hook that reads its sign-in functions from
 * the module you pass in, usually the generated `api.auth`. {@link useOauth}
 * returns the state that isn't tied to one provider.
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
 * {@link useOauthSignIn} and the per-provider hooks complete an OAuth callback
 * on mount. The flow returns to the page that started it, unless `redirectTo`
 * names another page. The auth state reports loading during the redemption
 * only when the hook mounts in the page's first render. So call
 * {@link useOauthCallback} on a custom `redirectTo` page, and in the app root
 * when the sign-in form renders only after loading finishes.
 *
 * Under `ConvexAuthNextjsProvider` the provider's `completeSignIn*` function
 * has to be in the proxy `signIn` allowlist. Its `startSignIn*` function runs
 * on the auth client's Convex client.
 *
 * @module
 */
"use client";

import { getFunctionName } from "convex/server";
import { useCallback, useEffect, useMemo, useSyncExternalStore } from "react";
import { useAuthClient } from "../react/client.tsx";
import {
  handleOauthCallback,
  startOauthSignIn,
  type OauthFlowError,
  type OauthProviderApi,
  type OauthProviderRefs,
  type SignInOptions,
  type SignInOutcome,
} from "./client.ts";
import { getOauthFlowError, subscribeOauthFlowError } from "./flowState.ts";

export type {
  OauthFlowError,
  OauthFlowErrorCode,
  OauthProviderApi,
  OauthProviderRefs,
  SignInOptions,
  SignInOutcome,
} from "./client.ts";

/** What {@link useOauth} returns. */
export type UseOauthReturn = {
  /**
   * Why the last sign-in attempt failed, or `null`. Cleared on the next
   * sign-in. Your app supplies the message text for each `code`. A
   * `rejected` error has a `message` from your own backend.
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
  const auth = useAuthClient();
  const subscribe = useCallback(
    (listener: () => void) => subscribeOauthFlowError(auth, listener),
    [auth],
  );
  const flowError = useSyncExternalStore(
    subscribe,
    () => getOauthFlowError(auth),
    () => null,
  );
  return { flowError };
}

/**
 * Complete the OAuth callback in the page URL on mount, and return the flow
 * error like {@link useOauth}. Use it on a custom `redirectTo` page that
 * renders no sign-in hook. The sign-in hooks call it themselves.
 */
export function useOauthCallback(): UseOauthReturn {
  const auth = useAuthClient();
  useEffect(() => {
    handleOauthCallback(auth);
  }, [auth]);
  return useOauth();
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
 * own references. It completes an OAuth callback on mount through
 * {@link useOauthCallback}.
 *
 * A failure while starting the flow rejects the returned promise. Failures
 * after the redirect back have no caller to catch them, so every failure is
 * also reported through {@link useOauth}'s `flowError`.
 */
export function useOauthSignIn(refs: OauthProviderRefs): UseOauthSignInReturn {
  const auth = useAuthClient();
  useOauthCallback();
  // Generated api objects create a fresh reference object on every property
  // access, so the memo depends on the function paths. The `refs` that the
  // memo uses can then be from an earlier render, which is fine because the
  // deps cover all three of its fields.
  const startPath = getFunctionName(refs.startSignIn);
  const completePath = getFunctionName(refs.completeSignIn);
  const { providerName } = refs;
  const signIn = useMemo(
    () =>
      (options?: SignInOptions): Promise<SignInOutcome> =>
        startOauthSignIn(auth, refs, options),
    [auth, providerName, startPath, completePath],
  );
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
