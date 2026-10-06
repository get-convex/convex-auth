/**
 * Framework-agnostic OAuth sign-in functions.
 *
 * Sign-in spans a full page round trip. {@link startOauthSignIn} gets the
 * identity provider URL and a `state` from the server, stores the pending
 * flow record, and navigates to the identity provider. The identity provider
 * returns to the app with a one-time code in the URL, and
 * {@link handleOauthCallback} redeems the code with the stored `state`. The
 * server checks that pair, so only the browser that started a sign-in can
 * finish it.
 *
 * Only a function that returns the shared sign-in result runs through
 * `auth.signIn`. {@link startOauthSignIn} says which client runs each
 * mutation.
 *
 * {@link readOauthCallback} reads the callback params and removes them from
 * the URL synchronously, before the first `await`. A second call sees a
 * clean URL and does nothing, so a double mount under React StrictMode
 * redeems a code once. Only the params this module sets are read, so a
 * `?code=` or `?error=` that the app uses stays in the URL.
 *
 * @module
 */
import {
  FunctionReference,
  getFunctionName,
  makeFunctionReference,
} from "convex/server";
import { ConvexError } from "convex/values";
import type { AuthClient } from "../browser/sessionManager.ts";
import type { SignInStorage } from "../browser/storage.ts";
import { OAUTH_CODE_PARAM, OAUTH_ERROR_PARAM } from "../lib/oauthParams.ts";
import type { ClientView } from "../lib/types.ts";
import { setOauthFlowError } from "./flowState.ts";
import type { CompleteSignInResult } from "./shared/redemption.ts";

/**
 * The mutations an OAuth provider adds to the app's API. Passed as
 * references, not names, because an app can re-export them under any name.
 */
export type OauthProviderApi = {
  /** The provider's `startSignIn*` mutation. */
  startSignIn: FunctionReference<
    "mutation",
    "public",
    { redirectTo: string },
    { redirect: string; state: string }
  >;
  /** The provider's `completeSignIn*` mutation. */
  completeSignIn: FunctionReference<
    "mutation",
    "public",
    { code: string; state: string },
    ClientView<CompleteSignInResult>
  >;
};

/** One provider's mutations plus its name. */
export type OauthProviderRefs = {
  /** The provider's name, e.g. `"google"`. Only a label, never a lookup key. */
  providerName: string;
} & OauthProviderApi;

/**
 * Why the last sign-in attempt failed. Apps map each code to their own
 * user-facing copy.
 *
 * - `"access_denied"`: the user cancelled at the identity provider.
 * - `"expired"`: the flow took too long, or the code was already redeemed.
 * - `"rejected"`: the app's own backend turned the sign-in down by throwing
 *   a `ConvexError`, and `message` has its text.
 * - `"oauth_error"`: something else went wrong during the provider handshake,
 *   including failing to start it.
 * - `"invalid_flow"`: the callback arrived but this client has no saved flow,
 *   so it never started this sign-in or already finished it.
 */
export type OauthFlowErrorCode =
  "access_denied" | "expired" | "rejected" | "oauth_error" | "invalid_flow";

/** Why a sign-in failed. */
export type OauthFlowError = {
  /** Why the sign-in failed. */
  code: OauthFlowErrorCode;
  /**
   * Text to show the user. Only set when the app's backend threw a
   * `ConvexError` whose `data` is a string. That string is this text.
   *
   * @TODO(erquhart) Look into localization support.
   */
  message?: string;
};

/** Options accepted by {@link startOauthSignIn}. */
export type SignInOptions = {
  /**
   * Where the flow returns to when it finishes. Defaults to the current URL,
   * and is required where there is no current URL, such as React Native.
   * Must be an http or https URL. Custom schemes like `myapp://` are not
   * supported yet.
   */
  redirectTo?: string;
  /** A callback `code` that completes the pending flow. No flow starts. */
  code?: string;
};

/**
 * What a sign-in call resolves to. Starting a flow gives back the identity
 * provider URL, which React Native has to open itself because this client
 * only navigates on the web. Finishing a flow with a `code` gives back
 * whether the user is signed in.
 */
export type SignInOutcome = { redirect: URL } | { signedIn: boolean };

/**
 * The `auth.signInStorage` id for OAuth. A different value would make a
 * client miss a pending flow record that an earlier release stored.
 */
export const OAUTH_STORAGE_ID = "oauth";

/** The `error` values the server callback can put in the URL. */
const SERVER_ERRORS: ReadonlySet<string> = new Set([
  "access_denied",
  "expired",
  "oauth_error",
]);

/** Storage key for the pending flow record. */
const OAUTH_FLOW_STORAGE_KEY = "flow";

/** What {@link startOauthSignIn} stores before it navigates away. */
export type PendingFlow = {
  /** Which provider the flow belongs to. */
  providerName: string;
  /**
   * The state the server returned when the flow started. The server checks
   * it to confirm that this client started the flow.
   */
  state: string;
  /**
   * The path of the provider's `completeSignIn` mutation, from
   * `getFunctionName`. The flow can return to any page of the app, including
   * one that never had the mutation reference, so the path is stored here and
   * the reference is rebuilt from it. If the app renames that export and
   * redeploys during a sign-in, the path does not resolve and the sign-in
   * fails as `oauth_error`.
   */
  completeSignIn: string;
};

/**
 * The current page URL, or null where there is none. React Native defines
 * `window` but no `window.location`, so checking for `window` alone isn't
 * enough.
 */
function currentHref(): string | null {
  if (typeof window === "undefined" || window.location === undefined) {
    return null;
  }
  return window.location.href;
}

/**
 * Read and remove the pending flow record. It is removed even if the redeem
 * that follows fails, because the code it pairs with is one-time and cannot
 * be used again anyway.
 */
async function takePendingFlow(
  storage: SignInStorage,
): Promise<PendingFlow | null> {
  const raw = await storage.get(OAUTH_FLOW_STORAGE_KEY);
  await storage.remove(OAUTH_FLOW_STORAGE_KEY);
  if (raw === null || raw === undefined) {
    return null;
  }
  try {
    const parsed = JSON.parse(raw) as {
      providerName?: unknown;
      state?: unknown;
      completeSignIn?: unknown;
    };
    if (
      typeof parsed.providerName !== "string" ||
      typeof parsed.state !== "string" ||
      typeof parsed.completeSignIn !== "string"
    ) {
      return null;
    }
    return {
      providerName: parsed.providerName,
      state: parsed.state,
      completeSignIn: parsed.completeSignIn,
    };
  } catch {
    return null;
  }
}

/**
 * Remove the pending flow record after the flow has ended. Callers do not
 * await this, so it ignores a failed removal to avoid an unhandled
 * rejection. The caller has already set the flow error.
 */
async function dropPendingFlow(storage: SignInStorage): Promise<void> {
  try {
    await storage.remove(OAUTH_FLOW_STORAGE_KEY);
  } catch {
    // Nothing to do. The flow was already over.
  }
}

/** Set or clear the flow error that apps read for sign-in feedback. */
function setFlowError(
  auth: AuthClient,
  code: OauthFlowErrorCode | null,
  message?: string,
): void {
  setOauthFlowError(auth, code === null ? null : { code, message });
}

/**
 * Set the flow error for a thrown sign-in failure. A `ConvexError` means the
 * app's backend rejected the sign-in. Anything else is a generic failure.
 */
function setThrownFlowError(auth: AuthClient, error: unknown): void {
  if (error instanceof ConvexError) {
    setFlowError(
      auth,
      "rejected",
      typeof error.data === "string" ? error.data : undefined,
    );
    return;
  }
  setFlowError(auth, "oauth_error");
}

/**
 * Start a provider's OAuth flow. It stores the pending flow record and, on
 * the web, navigates to the identity provider. Where there is no page URL,
 * such as React Native, it returns the identity provider URL for the app to
 * open. With `options.code` it completes the pending flow with that code
 * through {@link completeOauthSignIn}.
 *
 * The provider's `startSignIn` runs on `auth.convex`, because it returns a
 * redirect. Its `completeSignIn` runs on `auth.signIn`, because it returns
 * the sign-in result, which the Next.js proxy requires.
 *
 * A failed start sets the flow error and rejects, so UI that reads the flow
 * error shows the failure when the caller ignores the rejection.
 */
export async function startOauthSignIn(
  auth: AuthClient,
  refs: OauthProviderRefs,
  options?: SignInOptions,
): Promise<SignInOutcome> {
  if (options?.code !== undefined) {
    setFlowError(auth, null);
    return { signedIn: await completeOauthSignIn(auth, options.code) };
  }
  const href = currentHref();
  const redirectTo = options?.redirectTo ?? href;
  if (redirectTo === null) {
    throw new Error(
      "`redirectTo` is required where there is no current page URL, " +
        "such as React Native.",
    );
  }
  // Cleared after the check above, so a call that throws there leaves the
  // error that the app shows.
  setFlowError(auth, null);
  try {
    const { redirect, state } = await auth.convex.mutation(refs.startSignIn, {
      redirectTo,
    });
    await auth.signInStorage(OAUTH_STORAGE_ID).set(
      OAUTH_FLOW_STORAGE_KEY,
      JSON.stringify({
        providerName: refs.providerName,
        state,
        completeSignIn: getFunctionName(refs.completeSignIn),
      } satisfies PendingFlow),
    );
    const url = new URL(redirect);
    // React Native has no page URL to leave. It opens the returned url in an
    // in-app browser and completes with `startOauthSignIn(auth, refs, { code })`.
    if (href !== null && navigator.product !== "ReactNative") {
      window.location.href = url.toString();
    }
    return { redirect: url };
  } catch (error) {
    setThrownFlowError(auth, error);
    throw error;
  }
}

/**
 * Redeem a callback `code` with the pending flow record and store the
 * session. The redemption and `setSession` run inside
 * `auth.withSignInPending`, so the auth state reports loading until the
 * client is signed in. Resolves to whether the user is signed in. It never
 * rejects. Every failure sets the flow error.
 */
export async function completeOauthSignIn(
  auth: AuthClient,
  code: string,
): Promise<boolean> {
  return await auth.withSignInPending(async () => {
    // The storage read is inside the try so that a failed read sets the flow
    // error like any other failure here.
    try {
      const pending = await takePendingFlow(
        auth.signInStorage(OAUTH_STORAGE_ID),
      );
      if (pending === null) {
        setFlowError(auth, "invalid_flow");
        return false;
      }
      // TODO(erquhart) Look at getting this reference without storing its
      // path.
      const completeSignIn = makeFunctionReference<"mutation">(
        pending.completeSignIn,
      ) as OauthProviderApi["completeSignIn"];
      const result = await auth.signIn.mutation(completeSignIn, {
        code,
        state: pending.state,
      });
      if (result.status === "error") {
        // The server returns this one error for an unknown, already
        // redeemed, or expired code and for a mismatched state.
        setFlowError(auth, "expired");
        return false;
      }
      await auth.setSession(result.tokens);
      return true;
    } catch (error) {
      setThrownFlowError(auth, error);
      return false;
    }
  });
}

/**
 * Read the OAuth callback params from the page URL and remove them. It passes
 * `window.history.state` back to `replaceState`, because routers like React
 * Router store their own entry state there. Returns null when there is no
 * page URL or the URL has neither param. An unknown server error code becomes
 * `oauth_error`.
 */
export function readOauthCallback():
  { code: string } | { error: OauthFlowErrorCode } | null {
  const href = currentHref();
  if (href === null) {
    return null;
  }
  const url = new URL(href);
  const code = url.searchParams.get(OAUTH_CODE_PARAM);
  const errorParam = url.searchParams.get(OAUTH_ERROR_PARAM);
  if (code === null && errorParam === null) {
    return null;
  }
  url.searchParams.delete(OAUTH_CODE_PARAM);
  url.searchParams.delete(OAUTH_ERROR_PARAM);
  window.history.replaceState(window.history.state, "", url.toString());
  if (errorParam !== null) {
    return {
      error: SERVER_ERRORS.has(errorParam)
        ? (errorParam as OauthFlowErrorCode)
        : "oauth_error",
    };
  }
  return code === null ? null : { code };
}

/**
 * Finish the OAuth flow that the page URL returns to. An error param sets the
 * flow error and removes the pending flow record. A code starts
 * {@link completeOauthSignIn} without waiting for it. That call enters
 * `auth.withSignInPending` before this function returns. When this function
 * runs before `auth.init()` resolves, the auth state never reports signed out
 * during the redemption. Returns whether the URL had a callback param.
 */
export function handleOauthCallback(auth: AuthClient): boolean {
  const callback = readOauthCallback();
  if (callback === null) {
    return false;
  }
  if ("error" in callback) {
    // The server ended the flow with an error, so the stored state can never
    // be used. Removing it makes a stray code that arrives later report
    // `invalid_flow`.
    void dropPendingFlow(auth.signInStorage(OAUTH_STORAGE_ID));
    setFlowError(auth, callback.error);
    return true;
  }
  void completeOauthSignIn(auth, callback.code);
  return true;
}
