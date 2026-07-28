/**
 * Framework-agnostic client for the OAuth providers.
 *
 * A provider's job on the client is to run its own sign-in flow and hand the
 * resulting {@link TokenBundle} to the core client's `setSession`. OAuth's
 * flow spans a full page round-trip — `signIn` navigates away to the identity
 * provider, and the provider's callback redirects back with a one-time
 * `code` — so the {@link oauth} setup registers mount-time work: when the app
 * loads, it completes any pending flow.
 *
 * Flow: `signIn` asks the server for an authorization URL, keeps the minted
 * `state` in storage, and navigates away. The callback redirects back with a
 * one-time `code` (or a normalized `error`); on mount this client redeems
 * `code` + `state` for a {@link TokenBundle} and adopts the session. The
 * state is read from storage only, never from the URL: a client that accepts
 * state from URL params can be handed an attacker's flow and complete
 * sign-in into the attacker's account (login CSRF).
 *
 * Provider functions are passed as plain references: `signIn` takes the
 * provider's `startSignIn`/`completeSignIn` pair (see
 * {@link OauthProviderRefs}), typically picked off the app's `api.auth`
 * module. Completion must work on whatever page the flow returns to, where
 * the code that started the flow (and held the references) may not run, so
 * the pending-flow record persists the `completeSignIn` *function path*
 * (via `getFunctionName`) and mount-time completion rebuilds the reference
 * from storage.
 *
 * Nothing here depends on React — the hooks live in `./react`.
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
import type { NamespacedStorage } from "../browser/storage";
import { OAUTH_CODE_PARAM, OAUTH_ERROR_PARAM } from "../lib/oauthParams";
import type { TokenBundle } from "../lib/types";

/**
 * The client-callable mutations an OAuth provider adds to the app's API,
 * passed as references (not names) because an app may re-export them under
 * any names.
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

/**
 * Everything {@link OauthActions.signIn} needs to run one provider's flow:
 * the provider's mutation pair plus its name. The name never resolves
 * anything; it labels the pending flow for debugging and future
 * provider-scoped error copy.
 */
export type OauthProviderRefs = {
  /** The provider's name, e.g. `"google"`. A label, not a lookup key. */
  providerName: string;
} & OauthProviderApi;

/**
 * Why the last sign-in attempt failed, normalized so apps can map each code
 * to their own user-facing copy:
 *
 * - `"access_denied"`: the user cancelled at the identity provider.
 * - `"expired"`: the flow took too long, or the code was already redeemed.
 * - `"oauth_error"`: something else went wrong during the provider handshake.
 * - `"invalid_flow"`: the callback arrived without a matching pending flow —
 *   this client never started the sign-in (or already completed it).
 */
export type OauthFlowErrorCode =
  "access_denied" | "expired" | "oauth_error" | "invalid_flow";

/**
 * A sign-in flow error: the normalized {@link OauthFlowErrorCode} plus a
 * default, English, user-facing `message`. The message is a convenience so
 * apps can render something without writing their own copy — it is *not* a
 * stable string. Localize or rebrand by switching on `code` and ignoring
 * `message`.
 */
export type OauthFlowError = {
  /** The normalized reason the sign-in failed. */
  code: OauthFlowErrorCode;
  /** Default English copy for `code`. Not stable — match on `code`. */
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
   * Where the flow returns to when it completes. Must be an http(s) URL on
   * an allowed origin (see the provider's `allowedRedirectOrigins`); defaults
   * to the current URL. Custom-scheme deep links (`myapp://`) can't be
   * allowlisted yet, so React Native apps return via https universal links /
   * app links.
   */
  redirectTo?: string;
  /**
   * A callback `code` obtained out-of-band (React Native's in-app
   * browser). Completes the pending flow instead of starting one.
   */
  code?: string;
};

/**
 * What a sign-in call resolves to: the identity provider URL to open (React
 * Native, where the client doesn't navigate itself), or — for an out-of-band
 * `code` completion — whether the session was signed in.
 */
export type SignInOutcome = { redirect: URL } | { signedIn: boolean };

/**
 * The sign-in actions {@link oauth} registers in the auth client's store.
 * Per-provider conveniences (`useSignInWithGoogle`) live in `./react` and
 * delegate here with their references statically picked.
 */
export type OauthActions = {
  /**
   * Start the given provider's OAuth flow (or, with `options.code`, complete
   * one). Starting navigates away to the identity provider — except in React
   * Native, where the returned `redirect` URL should be opened in an in-app
   * browser and the `code` from its callback fed back via
   * `signIn(refs, { code })`, with an https universal-link `redirectTo`
   * (see {@link SignInOptions.redirectTo}).
   */
  signIn: (
    refs: OauthProviderRefs,
    options?: SignInOptions,
  ) => Promise<SignInOutcome>;
};

/** Store key where {@link oauth} registers its {@link OauthActions}. */
export const OAUTH_ACTIONS_STORE_KEY = "oauth/actions";

/**
 * Store key holding the current {@link OauthFlowError} object (or `null`).
 * Seeded at setup, so `undefined` means {@link oauth} was never registered.
 */
export const OAUTH_FLOW_ERROR_STORE_KEY = "oauth/flowError";

/** The `error` values the server callback emits (see the component's `http.ts`). */
const SERVER_ERRORS: ReadonlySet<string> = new Set([
  "access_denied",
  "expired",
  "oauth_error",
]);

/** Storage key for the pending sign-in flow. */
const OAUTH_FLOW_STORAGE_KEY = "__convexAuthOauthFlow";

/**
 * The record `signIn` persists to storage before redirecting to the identity provider.
 * The redirect can land on any page of the app, including one that never
 * called a sign-in hook, so the record carries everything completion needs:
 * the `state` to validate and the `completeSignIn` function path to invoke.
 */
type PendingFlow = {
  /** Which provider the flow belongs to (a label; see {@link OauthProviderRefs}). */
  providerName: string;
  /** The state minted at sign-in: proof this client initiated the flow. */
  state: string;
  /**
   * The function path of the provider's `completeSignIn` mutation (from
   * `getFunctionName`), rebuilt into a reference at completion. A path that
   * dangles by then (the app renamed the export and deployed mid-flight)
   * fails the call and surfaces as `oauth_error`.
   */
  completeSignIn: string;
};

/**
 * Take (read and remove) the pending sign-in flow stored at sign-in time.
 * Consumed whether or not the redemption that follows succeeds: the flow is
 * bound to a one-time code, so it can never be completed twice.
 */
async function takePendingFlow(
  storage: NamespacedStorage,
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
 * Client setup for the OAuth providers. It owns the flow's storage and
 * mount-time completion; the provider functions themselves arrive as
 * references with each {@link OauthActions.signIn} call (the React hooks pick
 * them off the app's `api.auth` statically), so the setup itself needs no
 * configuration. Register it via `ConvexAuthProvider`'s `use` prop.
 *
 * Completion runs on whatever page the flow returns to: sign-in persisted the
 * `completeSignIn` function path with the flow, so no provider wiring needs
 * to be mounted there.
 *
 * While a callback code is being redeemed the core auth state reports
 * loading, so `<AuthLoading>`/`<Unauthenticated>` behave correctly with no
 * extra gating in the app.
 */
export function oauth(): AuthProviderClientSetup {
  return ({ client, mutation }) => {
    if (client.store.get(OAUTH_ACTIONS_STORE_KEY) !== undefined) {
      throw new Error(
        "oauth() was registered twice on the same ConvexAuthProvider.",
      );
    }

    const setFlowError = (code: OauthFlowErrorCode | null): void => {
      client.store.set(
        OAUTH_FLOW_ERROR_STORE_KEY,
        code === null ? null : { code, message: FLOW_ERROR_MESSAGES[code] },
      );
    };

    /**
     * Redeem a callback `code` against the pending flow and adopt the
     * session. Wrapped in `withSignInPending` end to end — including
     * `setSession` — so the auth state reports loading until the client is
     * authenticated.
     */
    const completeFlow = async (code: string): Promise<boolean> =>
      await client.withSignInPending(async () => {
        const pending = await takePendingFlow(client.storage);
        if (pending === null) {
          setFlowError("invalid_flow");
          return false;
        }
        const completeSignIn = makeFunctionReference<"mutation">(
          pending.completeSignIn,
        ) as OauthProviderApi["completeSignIn"];
        try {
          const bundle = await retryOnNetworkError(() =>
            mutation(completeSignIn, { code, state: pending.state }),
          );
          if (bundle === null) {
            // Unknown, already redeemed, expired, or mismatched state — all
            // indistinguishable server-side.
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
     * Complete any pending flow the callback redirected back to. Reads and
     * strips the callback params synchronously, before any await, so a rerun
     * finds a clean URL and no-ops — the one-time code is only redeemed once.
     * Only the component's namespaced params are consumed, so an unrelated
     * `?code=`/`?error=` the app uses itself is left untouched.
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
      // Keep the current history state: routers (React Router) store their
      // own entry state there, and stripping our params must not discard it.
      window.history.replaceState(window.history.state, "", url.toString());
      if (errorParam !== null) {
        // The server ended the flow with an error, so the stored state can
        // never complete — drop it, keeping `invalid_flow` meaningful if a
        // stray code arrives later.
        void client.storage.remove(OAUTH_FLOW_STORAGE_KEY);
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

    const signIn: OauthActions["signIn"] = async (refs, options) => {
      setFlowError(null);
      if (options?.code !== undefined) {
        return { signedIn: await completeFlow(options.code) };
      }
      const { redirect, state } = await mutation(refs.startSignIn, {
        redirectTo: options?.redirectTo ?? window.location.href,
      });
      await client.storage.set(
        OAUTH_FLOW_STORAGE_KEY,
        JSON.stringify({
          providerName: refs.providerName,
          state,
          completeSignIn: getFunctionName(refs.completeSignIn),
        } satisfies PendingFlow),
      );
      const url = new URL(redirect);
      // Don't navigate in React Native: the app opens the returned URL in an
      // in-app browser and completes with `signIn(refs, { code })`.
      if (navigator.product !== "ReactNative") {
        window.location.href = url.toString();
      }
      return { redirect: url };
    };

    client.store.set(
      OAUTH_ACTIONS_STORE_KEY,
      { signIn } satisfies OauthActions,
    );
    setFlowError(null);
    return { onMount: handleCallback };
  };
}
