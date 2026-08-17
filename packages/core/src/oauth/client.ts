/**
 * Framework-agnostic client for the OAuth providers.
 *
 * Sign-in spans a full page round-trip, so this client saves what it needs
 * before navigating away and finishes the flow at startup. The server hands
 * back a `state` when a flow starts and this client keeps it locally, then
 * sends it back with the code from the callback URL. That pairing is what
 * proves this browser started the sign-in.
 *
 * @module
 */
import {
  FunctionReference,
  getFunctionName,
  makeFunctionReference,
} from "convex/server";
import type { AuthProviderClientSetup } from "../browser/providerSetup";
import { retryOnNetworkError } from "../browser/retry";
import type { ScopedStorage } from "../browser/storage";
import { OAUTH_CODE_PARAM, OAUTH_ERROR_PARAM } from "../lib/oauthParams";
import type { TokenBundle } from "../lib/types";

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
    TokenBundle | null
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
 * - `"oauth_error"`: something else went wrong during the provider handshake.
 * - `"invalid_flow"`: the callback arrived but this client has no saved flow,
 *   so it never started this sign-in or already finished it.
 */
export type OauthFlowErrorCode =
  "access_denied" | "expired" | "oauth_error" | "invalid_flow";

/** Why a sign-in failed, with default copy an app can render as-is. */
export type OauthFlowError = {
  /** Why the sign-in failed. */
  code: OauthFlowErrorCode;
  /**
   * Default English copy for `code`. Not a stable string. To localize or
   * rebrand, switch on `code` and ignore this.
   */
  message: string;
};

/** Default user-facing copy for each {@link OauthFlowErrorCode}. */
const FLOW_ERROR_MESSAGES: Record<OauthFlowErrorCode, string> = {
  access_denied: "Sign-in was cancelled.",
  expired: "Sign-in took too long. Please try again.",
  oauth_error: "Something went wrong during sign-in. Please try again.",
  invalid_flow: "This sign-in can't be completed here. Please try again.",
};

/** Options accepted by {@link OauthActions.signIn}. */
export type SignInOptions = {
  /**
   * Where the flow returns to when it finishes. Defaults to the current URL.
   * Must be an http or https URL. Custom schemes like `myapp://` are not
   * supported yet.
   */
  redirectTo?: string;
  /** A callback `code` to finish a saved flow instead of starting a new one. */
  code?: string;
};

/**
 * What a sign-in call resolves to. Starting a flow gives back the identity
 * provider URL, which React Native has to open itself because this client
 * only navigates on the web. Finishing a flow with a `code` gives back
 * whether the user is now signed in.
 */
export type SignInOutcome = { redirect: URL } | { signedIn: boolean };

/** The sign-in actions {@link oauth} registers in the auth client's store. */
export type OauthActions = {
  /**
   * Start the given provider's OAuth flow, or finish a saved one when
   * `options.code` is set. Starting navigates away to the identity provider.
   */
  signIn: (
    refs: OauthProviderRefs,
    options?: SignInOptions,
  ) => Promise<SignInOutcome>;
};

/** The id {@link oauth} registers under. */
export const OAUTH_SETUP_ID = "oauth";

/** Store key where {@link oauth} registers its {@link OauthActions}. */
export const OAUTH_ACTIONS_KEY = "actions";

/**
 * Store key holding the current {@link OauthFlowError}, or `null` when the
 * last attempt was fine. It is set at registration, so `undefined` means
 * {@link oauth} was never registered.
 */
export const OAUTH_FLOW_ERROR_KEY = "flowError";

/** The `error` values the server callback can put in the URL. */
const SERVER_ERRORS: ReadonlySet<string> = new Set([
  "access_denied",
  "expired",
  "oauth_error",
]);

/** Storage key for the saved sign-in flow. */
const OAUTH_FLOW_STORAGE_KEY = "flow";

/** What `signIn` saves before it navigates to the identity provider. */
type PendingFlow = {
  /** Which provider the flow belongs to. */
  providerName: string;
  /** The state minted at sign-in. Proof this client started the flow. */
  state: string;
  /**
   * The path of the provider's `completeSignIn` mutation, from
   * `getFunctionName`. The flow can return to any page of the app, including
   * one that never held the mutation reference, so the path is saved here and
   * the reference is rebuilt from it. If the app renamed that export and
   * redeployed mid-flight the path no longer resolves and the sign-in fails
   * as `oauth_error`.
   */
  completeSignIn: string;
};

/**
 * Read and remove the saved sign-in flow. It is removed even if the redeem
 * that follows fails, because the code it pairs with is one-time and cannot
 * be used again anyway.
 */
async function takePendingFlow(
  storage: ScopedStorage,
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
 * Client setup for the OAuth providers. It owns the flow's storage and the
 * startup work that finishes a flow. Provider mutations arrive with each
 * {@link OauthActions.signIn} call, so the setup takes no configuration.
 */
export function oauth(): AuthProviderClientSetup {
  const setup: AuthProviderClientSetup["setup"] = ({
    client,
    store,
    storage,
    signInApi,
  }) => {
    /** Set or clear the flow error apps read for sign-in feedback. */
    const setFlowError = (code: OauthFlowErrorCode | null): void => {
      store.set(
        OAUTH_FLOW_ERROR_KEY,
        code === null ? null : { code, message: FLOW_ERROR_MESSAGES[code] },
      );
    };

    /**
     * Redeem a callback `code` against the saved flow and adopt the session.
     * The whole thing runs inside `withSignInPending`, including
     * `setSession`, so the auth state stays on loading until the client is
     * signed in rather than flickering through signed out.
     */
    const completeFlow = async (code: string): Promise<boolean> =>
      await client.withSignInPending(async () => {
        const pending = await takePendingFlow(storage);
        if (pending === null) {
          setFlowError("invalid_flow");
          return false;
        }
        const completeSignIn = makeFunctionReference<"mutation">(
          pending.completeSignIn,
        ) as OauthProviderApi["completeSignIn"];
        try {
          const bundle = await retryOnNetworkError(() =>
            signInApi.mutation(completeSignIn, { code, state: pending.state }),
          );
          if (bundle === null) {
            // The server can't tell unknown, already redeemed, expired, and
            // mismatched state apart, so they all land here.
            setFlowError("expired");
            return false;
          }
          await client.setSession(bundle);
          return true;
        } catch {
          setFlowError("oauth_error");
          return false;
        }
      });

    /**
     * Finish a flow the callback redirected back to. The params are read and
     * stripped from the URL before the first await, so if this runs twice the
     * second run sees a clean URL and does nothing. Only the params this
     * client owns are touched, so a `?code=` or `?error=` the app uses for its
     * own purposes is left alone.
     */
    const handleCallback = (): void => {
      if (typeof window === "undefined") {
        return;
      }
      const url = new URL(window.location.href);
      const code = url.searchParams.get(OAUTH_CODE_PARAM);
      const errorParam = url.searchParams.get(OAUTH_ERROR_PARAM);
      if (code === null && errorParam === null) {
        return;
      }
      url.searchParams.delete(OAUTH_CODE_PARAM);
      url.searchParams.delete(OAUTH_ERROR_PARAM);
      // Pass the current history state back through. Routers like React
      // Router keep their own entry state there and stripping our params must
      // not drop it.
      window.history.replaceState(window.history.state, "", url.toString());
      if (errorParam !== null) {
        // The server ended the flow with an error, so the saved state can
        // never be used. Drop it now so a stray code arriving later still
        // reports `invalid_flow`.
        void storage.remove(OAUTH_FLOW_STORAGE_KEY);
        setFlowError(
          SERVER_ERRORS.has(errorParam)
            ? (errorParam as OauthFlowErrorCode)
            : "oauth_error",
        );
        return;
      }
      if (code === null) {
        return;
      }
      void completeFlow(code);
    };

    /** Start a provider's flow, or finish a saved one when `code` is given. */
    const signIn: OauthActions["signIn"] = async (refs, options) => {
      setFlowError(null);
      if (options?.code !== undefined) {
        return { signedIn: await completeFlow(options.code) };
      }
      const { redirect, state } = await signInApi.mutation(refs.startSignIn, {
        redirectTo: options?.redirectTo ?? window.location.href,
      });
      await storage.set(
        OAUTH_FLOW_STORAGE_KEY,
        JSON.stringify({
          providerName: refs.providerName,
          state,
          completeSignIn: getFunctionName(refs.completeSignIn),
        } satisfies PendingFlow),
      );
      const url = new URL(redirect);
      // Don't navigate in React Native. The app opens the returned URL in an
      // in-app browser and finishes with `signIn(refs, { code })`.
      if (navigator.product !== "ReactNative") {
        window.location.href = url.toString();
      }
      return { redirect: url };
    };

    store.set(OAUTH_ACTIONS_KEY, { signIn } satisfies OauthActions);
    setFlowError(null);
    return { onInit: handleCallback };
  };
  return { id: OAUTH_SETUP_ID, setup };
}
