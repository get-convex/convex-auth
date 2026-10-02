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
import { ConvexError } from "convex/values";
import { retryOnNetworkError } from "../browser/retry.ts";
import type { AuthClient } from "../browser/sessionManager.ts";
import { NamespacedStorage, type TokenStorage } from "../browser/storage.ts";
import { OAUTH_CODE_PARAM, OAUTH_ERROR_PARAM } from "../lib/oauthParams.ts";
import type { AuthSignInApi, ClientView } from "../lib/types.ts";
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

/** Options accepted by {@link OauthClient.signIn}. */
export type SignInOptions = {
  /**
   * Where the flow returns to when it finishes. Defaults to the current URL,
   * and is required where there is no current URL, such as React Native.
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

/** The `error` values the server callback can put in the URL. */
const SERVER_ERRORS: ReadonlySet<string> = new Set([
  "access_denied",
  "expired",
  "oauth_error",
]);

/** Storage key for the saved sign-in flow. */
export const OAUTH_FLOW_STORAGE_KEY = "__convexAuthOauthFlow";

/** What `signIn` saves before it navigates to the identity provider. */
export type PendingFlow = {
  /**
   * The state the server gave back at sign-in. Proof this client started the
   * flow.
   */
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

/** Configuration for the {@link OauthClient}. */
export type OauthClientConfig = {
  /** The core client a finished sign-in hands its session to. */
  authClient: AuthClient;
  /** Runs the provider's sign-in mutations. */
  signInApi: AuthSignInApi;
  /** Where the pending flow is saved across the redirect. */
  storage: TokenStorage;
  /** Namespace for the storage key; the same one the `AuthClient` uses. */
  storageNamespace: string;
};

/**
 * Client for the OAuth providers. It owns the saved flow and the flow error,
 * and finishes a flow the callback redirected back to when
 * {@link OauthClient.handleCallback} runs at startup. Provider mutations
 * arrive with each {@link OauthClient.signIn} call, so one client serves
 * every provider.
 */
export class OauthClient {
  readonly #authClient: AuthClient;
  readonly #signInApi: AuthSignInApi;
  readonly #storage: NamespacedStorage;
  #flowError: OauthFlowError | null = null;
  readonly #listeners = new Set<() => void>();

  constructor(config: OauthClientConfig) {
    this.#authClient = config.authClient;
    this.#signInApi = config.signInApi;
    this.#storage = new NamespacedStorage(
      config.storage,
      config.storageNamespace,
    );
  }

  /**
   * Subscribe to changes of {@link getFlowError}. Returns an unsubscribe
   * function.
   */
  subscribe = (listener: () => void): (() => void) => {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  };

  /** Why the last sign-in attempt failed, or `null` when it was fine. */
  getFlowError = (): OauthFlowError | null => this.#flowError;

  /**
   * Finish a flow the callback redirected back to. Call it at startup,
   * synchronously and right before `AuthClient.init()`, so a redemption it
   * starts holds the auth state on loading through the session load rather
   * than letting it flash signed out.
   *
   * It does nothing unless the URL carries this client's own params. They
   * are read and stripped from the URL before the first await, so if this
   * runs twice the second run sees a clean URL and does nothing. Only the
   * params this client owns are touched, so a `?code=` or `?error=` the app
   * uses for its own purposes is left alone.
   *
   * It never throws. Every failure becomes a flow error instead, because a
   * throw here would keep the session from loading.
   */
  handleCallback = (): void => {
    try {
      const href = currentHref();
      if (href === null) {
        return;
      }
      const url = new URL(href);
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
        void this.#dropPendingFlow();
        this.#setFlowError(
          SERVER_ERRORS.has(errorParam)
            ? (errorParam as OauthFlowErrorCode)
            : "oauth_error",
        );
        return;
      }
      if (code === null) {
        return;
      }
      void this.#completeFlow(code);
    } catch {
      this.#setFlowError("oauth_error");
    }
  };

  /**
   * Start the given provider's OAuth flow, or finish a saved one when
   * `options.code` is set. Starting navigates away to the identity provider.
   */
  signIn = async (
    refs: OauthProviderApi,
    options?: SignInOptions,
  ): Promise<SignInOutcome> => {
    if (options?.code !== undefined) {
      this.#setFlowError(null);
      return { signedIn: await this.#completeFlow(options.code) };
    }
    const href = currentHref();
    const redirectTo = options?.redirectTo ?? href;
    if (redirectTo === null) {
      throw new Error(
        "`redirectTo` is required where there is no current page URL, " +
          "such as React Native.",
      );
    }
    // Cleared here rather than at the top, so a call that throws above
    // leaves any error the app is showing alone.
    this.#setFlowError(null);
    try {
      const { redirect, state } = await this.#signInApi.mutation(
        refs.startSignIn,
        { redirectTo },
      );
      await this.#storage.set(
        OAUTH_FLOW_STORAGE_KEY,
        JSON.stringify({
          state,
          completeSignIn: getFunctionName(refs.completeSignIn),
        } satisfies PendingFlow),
      );
      const url = new URL(redirect);
      // Don't navigate where there's no page URL to leave. React Native has
      // none, so it gets the url back, opens it in an in-app browser, and
      // finishes with `signIn(refs, { code })`.
      if (href !== null && navigator.product !== "ReactNative") {
        window.location.href = url.toString();
      }
      return { redirect: url };
    } catch (error) {
      // Record the failure before rethrowing, so UI reading the flow error
      // still shows something when the caller ignores the rejection.
      this.#setThrownFlowError(error);
      throw error;
    }
  };

  /** Set or clear the flow error apps read for sign-in feedback. */
  #setFlowError(code: OauthFlowErrorCode | null, message?: string): void {
    this.#flowError = code === null ? null : { code, message };
    for (const listener of this.#listeners) listener();
  }

  /**
   * Turn a thrown sign-in failure into a flow error. A `ConvexError` means
   * the app's backend rejected the sign-in. Anything else is a generic
   * failure.
   */
  #setThrownFlowError(error: unknown): void {
    if (error instanceof ConvexError) {
      this.#setFlowError(
        "rejected",
        typeof error.data === "string" ? error.data : undefined,
      );
      return;
    }
    this.#setFlowError("oauth_error");
  }

  /**
   * Redeem a callback `code` against the saved flow and adopt the session.
   * The whole thing runs inside `withSignInPending`, including `setSession`,
   * so the auth state stays on loading until the client is signed in rather
   * than flickering through signed out. It never rejects. Every failure
   * becomes a flow error instead, so callers that don't await it are safe.
   */
  async #completeFlow(code: string): Promise<boolean> {
    return await this.#authClient.withSignInPending(async () => {
      // The storage read is inside the try so that a failed read becomes a
      // flow error like any other failure here.
      try {
        const pending = await this.#takePendingFlow();
        if (pending === null) {
          this.#setFlowError("invalid_flow");
          return false;
        }
        // TODO(erquhart) Look at getting this reference without storing
        // its path.
        const completeSignIn = makeFunctionReference<"mutation">(
          pending.completeSignIn,
        ) as OauthProviderApi["completeSignIn"];
        const result = await retryOnNetworkError(() =>
          this.#signInApi.mutation(completeSignIn, {
            code,
            state: pending.state,
          }),
        );
        if (result.status === "error") {
          // The server can't tell unknown, already redeemed, expired, and
          // mismatched state apart, so they all land here.
          this.#setFlowError("expired");
          return false;
        }
        await this.#authClient.setSession(result.tokens);
        return true;
      } catch (error) {
        this.#setThrownFlowError(error);
        return false;
      }
    });
  }

  /**
   * Read and remove the saved sign-in flow. It is removed even if the redeem
   * that follows fails, because the code it pairs with is one-time and cannot
   * be used again anyway.
   */
  async #takePendingFlow(): Promise<PendingFlow | null> {
    const raw = await this.#storage.get(OAUTH_FLOW_STORAGE_KEY);
    await this.#storage.remove(OAUTH_FLOW_STORAGE_KEY);
    if (raw === null || raw === undefined) {
      return null;
    }
    try {
      const parsed = JSON.parse(raw) as {
        state?: unknown;
        completeSignIn?: unknown;
      };
      if (
        typeof parsed.state !== "string" ||
        typeof parsed.completeSignIn !== "string"
      ) {
        return null;
      }
      return {
        state: parsed.state,
        completeSignIn: parsed.completeSignIn,
      };
    } catch {
      return null;
    }
  }

  /**
   * Remove the saved sign-in flow after it has ended. Callers don't await
   * this, so a failed removal is ignored instead of becoming an unhandled
   * rejection. The caller already recorded why the sign-in failed.
   */
  async #dropPendingFlow(): Promise<void> {
    try {
      await this.#storage.remove(OAUTH_FLOW_STORAGE_KEY);
    } catch {
      // Nothing to do. The flow was already over.
    }
  }
}
