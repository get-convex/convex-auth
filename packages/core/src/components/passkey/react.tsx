/**
 * React client for the passkey provider, exported at
 * `@convex-dev/auth/providers/passkey/react`.
 *
 * The React client wraps the browser-side WebAuthentication code
 * (`navigator.credentials`). It exports a `usePasskey` hook that is used
 * on the passkey login form, which handles both:
 * - Manually logging in by providing an identifier (e.g. username)
 *   then registering a new passkey or logging in
 * - Passkey autofill (conditional mediation) where the user selects an account
 *   directly in the autocompletion list.
 *
 * @module
 */
"use client";

import { useConvex } from "convex/react";
import type { FunctionReference } from "convex/server";
import { useCallback, useEffect, useRef, useState } from "react";
import type { ClientView } from "../../lib/types.js";
import { useAuthActions, useAuthSignInApi } from "../../react/index.js";
import type {
  FinishSignInResult,
  FinishSignUpResult,
  StartAutofillSignInResult,
  StartSignInResult,
} from "./setup.js";
import { CHALLENGE_TTL_MS } from "./validation.js";

/**
 * The `startSignIn` mutation the app re-exports from its `setupCore`.
 */
type StartSignInMutation = FunctionReference<
  "mutation",
  "public",
  { username: string },
  StartSignInResult
>;

/**
 * The `startAutofillSignIn` mutation the app re-exports from its
 * `setupCore`.
 */
type StartAutofillSignInMutation = FunctionReference<
  "mutation",
  "public",
  Record<string, never>,
  StartAutofillSignInResult
>;

/**
 * The `finishSignUp` mutation the app re-exports from its `setupCore`.
 *
 * Its return value is the access-only {@link ClientView}, which is what both
 * session models have in common. Hand it to `setSession`, the only supported
 * consumer.
 */
type FinishSignUpMutation = FunctionReference<
  "mutation",
  "public",
  {
    username: string;
    attestationObject: ArrayBuffer;
    clientDataJSON: ArrayBuffer;
  },
  ClientView<FinishSignUpResult>
>;

/**
 * The `finishSignIn` mutation the app re-exports from its `setupCore`.
 */
type FinishSignInMutation = FunctionReference<
  "mutation",
  "public",
  {
    credentialId: ArrayBuffer;
    authenticatorData: ArrayBuffer;
    clientDataJSON: ArrayBuffer;
    signature: ArrayBuffer;
  },
  ClientView<FinishSignInResult>
>;

/** The mutation references {@link usePasskey} drives. */
export type PasskeyApi = {
  startSignIn: StartSignInMutation;
  startAutofillSignIn: StartAutofillSignInMutation;
  finishSignIn: FinishSignInMutation;
  finishSignUp: FinishSignUpMutation;
};

/**
 * Failures the client produces that the server never returns. The hook
 * folds them into the result so callers handle *every* failure through the
 * one `userError` switch and never need their own `try`/`catch`:
 *
 * - `CEREMONY_ABORTED`: the user dismissed the passkey dialog, the browser
 *   refused the ceremony (`NotAllowedError`), or a second `signIn` call
 *   came in while one was already running (the browser would refuse the
 *   second modal ceremony anyway). This is the most common failure; show a
 *   calm "sign-in was cancelled" message.
 * - `WEBAUTHN_UNSUPPORTED`: the browser has no WebAuthn support, or the
 *   page is not a secure context.
 * - `OTHER_ERROR`: everything else thrown (a network blip, a bug, an
 *   unexpected server error). The thrown value is preserved on `cause` for
 *   callers that want to inspect or log it.
 */
type ClientFailure = {
  success: false;
  userError:
    | { error: "CEREMONY_ABORTED" }
    | { error: "WEBAUTHN_UNSUPPORTED" }
    | { error: "OTHER_ERROR"; cause: unknown };
};

/**
 * The result of the `signIn` callback from {@link usePasskey}.
 *
 * A success carries a `flow` discriminant: `"signUp"` when the ceremony
 * created a new account, `"signIn"` when it authenticated an existing one.
 */
export type PasskeySignInResult =
  | (Extract<ClientView<FinishSignUpResult>, { success: true }> & {
      flow: "signUp";
    })
  | (Extract<ClientView<FinishSignInResult>, { success: true }> & {
      flow: "signIn";
    })
  | Extract<ClientView<FinishSignUpResult>, { success: false }>
  | Extract<ClientView<FinishSignInResult>, { success: false }>
  | Extract<StartSignInResult, { success: false }>
  | ClientFailure;

/**
 * The failures the `autofill` flow of {@link usePasskey} reports through
 * `lastError`: the server's `finishSignIn` errors plus the client-side
 * {@link ClientFailure} errors. Every thrown value is folded into this
 * shape, so callers handle every failure through the one `error` switch.
 */
export type PasskeyAutofillError =
  | Extract<FinishSignInResult, { success: false }>["userError"]
  | ClientFailure["userError"];

/**
 * The states of the `autofill` flow of {@link usePasskey}:
 *
 * - `"idle"`: the flow has not started yet, or autofill is off.
 * - `"waiting"`: the autofill request is pending in the browser.
 * - `"signingIn"`: an assertion is being verified on the server.
 * - `"signedIn"`: the sign-in succeeded and the session is set.
 * - `"stopped"`: the flow is done without a sign-in (cancellation,
 *   failure, or no browser support).
 */
export type PasskeyAutofillStatus =
  "idle" | "waiting" | "signingIn" | "signedIn" | "stopped";

// A pending autofill request refreshes its challenge before the server's
// challenge TTL expires. The two-minute margin makes sure the challenge
// that the user finally redeems is never expired.
const AUTOFILL_REFRESH_MS = CHALLENGE_TTL_MS - 2 * 60 * 1000;

// After this many autofill assertions in a row come back as a `userError`,
// the autofill flow stops instead of asking the browser again.
const MAX_AUTOFILL_FAILURES = 3;

// The values a pending autofill `credentials.get()` is aborted with. The
// promise rejects with the abort reason, so the loop can tell why it woke.
type AutofillAbortReason = "STOP" | "REFRESH" | "PAUSE";

/**
 * The pause/resume gates of a running autofill loop. `pause()` aborts the
 * in-flight browser request and resolves when the loop is parked;
 * `resume()` lets the loop start a fresh request.
 */
type AutofillHandle = {
  pause: () => Promise<void>;
  resume: () => void;
};

function supportsWebAuthn(): boolean {
  return (
    typeof window !== "undefined" &&
    typeof PublicKeyCredential !== "undefined" &&
    window.isSecureContext
  );
}

function isCeremonyAborted(cause: unknown): boolean {
  // `NotAllowedError` is what the browser throws when the user dismisses
  // the dialog, when the ceremony times out, and when the page is not
  // allowed to run one. A `null` credential is handled separately.
  return cause instanceof DOMException && cause.name === "NotAllowedError";
}

/**
 * Fold a thrown value into the {@link ClientFailure} `userError` shape, so
 * callers handle every failure through the one `userError` switch.
 */
function foldClientError(cause: unknown): ClientFailure["userError"] {
  if (isCeremonyAborted(cause)) {
    return { error: "CEREMONY_ABORTED" };
  }
  return { error: "OTHER_ERROR", cause };
}

/**
 * When the thrown value is the abort of the given signal, return the abort
 * reason. Return `null` for every other error, even when the signal aborted
 * afterwards: a real failure can race a `PAUSE`/`REFRESH` abort, and the
 * signal alone would misattribute it.
 */
function autofillAbortReason(
  error: unknown,
  signal: AbortSignal,
): AutofillAbortReason | null {
  if (error === "STOP" || error === "REFRESH" || error === "PAUSE") {
    // The browser rejected with the abort reason itself.
    return error;
  }
  if (
    error instanceof DOMException &&
    error.name === "AbortError" &&
    signal.aborted
  ) {
    // The browser rejected with a generic `AbortError`: the reason is on
    // the signal.
    const reason = signal.reason as unknown;
    if (reason === "REFRESH" || reason === "PAUSE") {
      return reason;
    }
    return "STOP";
  }
  return null;
}

/** The `finishSignIn` arguments derived from a WebAuthn assertion. */
type AssertionArgs = {
  credentialId: ArrayBuffer;
  authenticatorData: ArrayBuffer;
  clientDataJSON: ArrayBuffer;
  signature: ArrayBuffer;
};

/**
 * Turn an assertion credential into the `finishSignIn` arguments. Shared
 * between the modal authenticate path and the autofill path.
 */
function assertionArgs(credential: PublicKeyCredential): AssertionArgs {
  const response = credential.response as AuthenticatorAssertionResponse;
  return {
    // `rawId` carries the credential ID bytes; `credential.id` is the
    // base64url form and must not be sent.
    credentialId: credential.rawId,
    authenticatorData: response.authenticatorData,
    clientDataJSON: response.clientDataJSON,
    signature: response.signature,
  };
}

/**
 * Run the modal registration ceremony and return the `finishSignUp`
 * arguments, or `null` when the browser returns no credential.
 */
async function runRegistrationCeremony(
  username: string,
  start: Extract<StartSignInResult, { step: "register" }>,
): Promise<{
  username: string;
  attestationObject: ArrayBuffer;
  clientDataJSON: ArrayBuffer;
} | null> {
  const credential = (await navigator.credentials.create({
    publicKey: {
      challenge: start.challenge,
      rp: { id: start.rpId, name: start.rpName },
      // The handle comes from the server: the app user id cannot be used,
      // because the user row does not exist yet.
      user: {
        id: start.userHandle,
        name: username,
        displayName: username,
      },
      // Exactly the algorithms the server accepts (ES256 and RS256; see
      // the verification in `registration.ts`).
      pubKeyCredParams: [
        { type: "public-key", alg: -7 }, // ES256
        { type: "public-key", alg: -257 }, // RS256
      ],
      // A discoverable credential is required for autofill, and the
      // server hard-requires user verification.
      authenticatorSelection: {
        residentKey: "required",
        requireResidentKey: true,
        userVerification: "required",
      },
      attestation: "none",
      excludeCredentials: start.excludeCredentials.map((id) => ({
        type: "public-key",
        id,
      })),
    },
  })) as PublicKeyCredential | null;
  if (credential === null) {
    return null;
  }
  const response = credential.response as AuthenticatorAttestationResponse;
  return {
    username,
    attestationObject: response.attestationObject,
    clientDataJSON: response.clientDataJSON,
  };
}

/**
 * Run the modal authentication ceremony and return the `finishSignIn`
 * arguments, or `null` when the browser returns no credential.
 */
async function runAuthenticationCeremony(
  start: Extract<StartSignInResult, { step: "authenticate" }>,
): Promise<AssertionArgs | null> {
  const credential = (await navigator.credentials.get({
    publicKey: {
      challenge: start.challenge,
      rpId: start.rpId,
      allowCredentials: start.allowCredentials.map((id) => ({
        type: "public-key",
        id,
      })),
      userVerification: "required",
    },
  })) as PublicKeyCredential | null;
  if (credential === null) {
    return null;
  }
  return assertionArgs(credential);
}

/**
 * Client for the passkey provider.
 *
 * This client handles both:
 * - Manually logging in by providing an identifier (e.g. username)
 *   then registering a new passkey or logging in
 * - Passkey autofill (conditional mediation) where the user selects an account
 *   directly in the autocompletion list.
 *
 * ```tsx
 * import { usePasskey } from "@convex-dev/auth/providers/passkey/react";
 * import { api } from "../convex/_generated/api";
 *
 * function LogIn() {
 *   const { signIn, pending, autofill } = usePasskey({
 *     startSignIn: api.auth.startSignIn,
 *     startAutofillSignIn: api.auth.startAutofillSignIn,
 *     finishSignIn: api.auth.finishSignIn,
 *     finishSignUp: api.auth.finishSignUp,
 *   });
 *   return (
 *     <form
 *       onSubmit={async (e) => {
 *         e.preventDefault();
 *         const result = await signIn({ username });
 *         if (!result.success) {
 *           // map result.userError to a message
 *         }
 *       }}
 *     >
 *       <input autoComplete="username webauthn" ... />
 *       <button disabled={pending}>Continue</button>
 *     </form>
 *   );
 * }
 * ```
 *
 * @param passkeyApi The app's re-exported passkey mutation references.
 * @param options Set `autofill: false` to keep the autofill request off.
 */
export function usePasskey(
  passkeyApi: PasskeyApi,
  options: { autofill?: boolean } = {},
) {
  // TODO(nicolas) Refactor this hook, potentially allow more extensibility

  const { autofill: autofillEnabled = true } = options;
  const { setSession } = useAuthActions();
  // Running the two finishing mutations through the signInApi rather than
  // `useMutation` is what lets this hook serve both session models (SPA +
  // SSR): under SSR they go through the auth proxy, which keeps the refresh
  // token in an httpOnly cookie.
  const signInApi = useAuthSignInApi();
  // The two starting mutations mint a challenge rather than a session, so
  // they go straight to the deployment in both models. The proxy only speaks
  // the sign-in envelope and would refuse their shape.
  const convex = useConvex();

  // The identifier-first (modal) flow's state.
  const [pending, setPending] = useState(false);
  // The re-entry guard reads through a ref: `pending` from `useState`
  // would be stale inside the callback.
  const pendingRef = useRef(false);

  // The autofill flow's state.
  const [autofillAvailable, setAutofillAvailable] = useState<boolean | null>(
    null,
  );
  const [autofillStatus, setAutofillStatus] =
    useState<PasskeyAutofillStatus>("idle");
  const [autofillLastError, setAutofillLastError] =
    useState<PasskeyAutofillError | null>(null);
  const cancelAutofillRef = useRef<() => void>(() => {});

  // The pause/resume handle of the pending autofill request; `null` while
  // no autofill loop runs. Browsers reject a modal `credentials.create()`
  // /`get()` while a conditional (autofill) request is pending on the same
  // page, so the modal flow must pause the autofill request first and
  // resume it when the modal ceremony is over. Both flows live in this
  // hook, so the handle is instance state — a ref — and no cross-component
  // coordination exists.
  const autofillHandleRef = useRef<AutofillHandle | null>(null);

  // The flows read the mutation references, the two call paths and
  // `setSession` through a ref: their identities are not stable across
  // renders (Convex's generated `api` object creates a new reference on
  // every property access), and neither `signIn`'s identity nor the
  // pending browser request must change on a render.
  const currentRef = useRef({ passkeyApi, signInApi, convex, setSession });
  currentRef.current = { passkeyApi, signInApi, convex, setSession };

  const signIn = useCallback(
    async ({
      username,
    }: {
      username: string;
    }): Promise<PasskeySignInResult> => {
      // Refuse a second call while one is running: it would deadlock the
      // autofill pause/resume protocol, and the browser rejects a second
      // modal ceremony anyway.
      if (pendingRef.current) {
        return { success: false, userError: { error: "CEREMONY_ABORTED" } };
      }
      pendingRef.current = true;
      setPending(true);
      // Pause the pending autofill request before the modal ceremony, and
      // resume it whatever the outcome. Capture the handle once, so pause
      // and resume act on the same loop even when the autofill effect
      // restarts mid-ceremony.
      const autofillHandle = autofillHandleRef.current;
      await autofillHandle?.pause();
      try {
        if (!supportsWebAuthn()) {
          return {
            success: false,
            userError: { error: "WEBAUTHN_UNSUPPORTED" },
          };
        }
        const { passkeyApi, signInApi, convex, setSession } =
          currentRef.current;

        const start = await convex.mutation(passkeyApi.startSignIn, {
          username,
        });
        if (!start.success) {
          return start;
        }

        if (start.step === "register") {
          const args = await runRegistrationCeremony(username, start);
          if (args === null) {
            return { success: false, userError: { error: "CEREMONY_ABORTED" } };
          }
          const result = await signInApi.mutation(
            passkeyApi.finishSignUp,
            args,
          );
          if (!result.success) {
            return result;
          }
          await setSession(result.tokens);
          return { ...result, flow: "signUp" };
        }

        const args = await runAuthenticationCeremony(start);
        if (args === null) {
          return { success: false, userError: { error: "CEREMONY_ABORTED" } };
        }
        const result = await signInApi.mutation(passkeyApi.finishSignIn, args);
        if (!result.success) {
          return result;
        }
        await setSession(result.tokens);
        return { ...result, flow: "signIn" };
      } catch (cause) {
        return { success: false, userError: foldClientError(cause) };
      } finally {
        autofillHandle?.resume();
        // Reset even when something throws.
        pendingRef.current = false;
        setPending(false);
      }
    },
    [],
  );

  useEffect(() => {
    if (!autofillEnabled) {
      // Report the off state, so `status` does not stay stuck on the last
      // value of a previous enabled run.
      setAutofillStatus("idle");
      // No detection runs and the autocompletion list will not offer
      // passkeys. Report `false`, so `available` does not stay on `null`
      // ("detection runs") forever.
      setAutofillAvailable(false);
      return;
    }
    // The outer controller lives for the whole effect. The cleanup aborts
    // it with `STOP`, which makes the autofill flow StrictMode-safe by
    // construction: the throwaway first mount's loop sees its own
    // controller aborted and exits, while the second mount runs its own
    // loop with its own controller.
    const outer = new AbortController();
    cancelAutofillRef.current = () =>
      outer.abort("STOP" satisfies AutofillAbortReason);

    // The pause/resume gates behind the {@link AutofillHandle} this effect
    // publishes on `autofillHandleRef`. The pauses are reference-counted,
    // so nested pause/resume pairs compose (the modal flow and the
    // tab-visibility pause can overlap).
    let pauseCount = 0;
    let parked = false;
    let inner: AbortController | null = null;
    let onParked: (() => void) | null = null;
    let onResumed: (() => void) | null = null;
    const handle: AutofillHandle = {
      pause: () => {
        pauseCount += 1;
        if (parked) {
          // The loop is already parked: there is nothing to wait for.
          return Promise.resolve();
        }
        // Chain onto an earlier waiter, so two concurrent `pause()` calls
        // both resolve when the loop parks.
        const previous = onParked;
        const parkedPromise = new Promise<void>((resolve) => {
          onParked = () => {
            previous?.();
            resolve();
          };
        });
        inner?.abort("PAUSE" satisfies AutofillAbortReason);
        return parkedPromise;
      },
      resume: () => {
        pauseCount = Math.max(0, pauseCount - 1);
        if (pauseCount === 0) {
          onResumed?.();
          onResumed = null;
        }
      },
    };

    // Pause the loop while the tab is hidden: a background tab must not
    // keep minting fresh challenges. On return to a visible tab, the loop
    // resumes with a fresh challenge.
    let pausedForVisibility = false;
    const onVisibilityChange = () => {
      if (document.hidden && !pausedForVisibility) {
        pausedForVisibility = true;
        void handle.pause();
      } else if (!document.hidden && pausedForVisibility) {
        pausedForVisibility = false;
        handle.resume();
      }
    };
    if (typeof document !== "undefined") {
      document.addEventListener("visibilitychange", onVisibilityChange);
      // The tab can already be hidden when the effect runs.
      onVisibilityChange();
    }

    const run = async () => {
      // Feature-detect conditional mediation. The method is a static one,
      // and it is absent in older browsers: guard before calling it. Count
      // a rejection as "not available": if it escaped, the promise chain
      // below would reject unhandled and the hook would stay on
      // `available: null` and `status: "idle"` forever.
      let supported = false;
      try {
        supported =
          supportsWebAuthn() &&
          typeof PublicKeyCredential.isConditionalMediationAvailable ===
            "function" &&
          (await PublicKeyCredential.isConditionalMediationAvailable());
      } catch {
        // Keep `supported` as `false`.
      }
      if (outer.signal.aborted) {
        return;
      }
      setAutofillAvailable(supported);
      if (!supported) {
        setAutofillStatus("stopped");
        return;
      }

      // Publish the handle for the modal flow. A StrictMode remount
      // cannot get here twice: the first mount's loop sees its aborted
      // controller at the check above and returns first.
      autofillHandleRef.current = handle;
      let failures = 0;
      while (!outer.signal.aborted) {
        if (pauseCount > 0) {
          // Park until the modal flow resumes us (or the hook stops).
          parked = true;
          onParked?.();
          onParked = null;
          let release!: () => void;
          const parkWait = new Promise<void>((resolve) => {
            release = resolve;
          });
          onResumed = release;
          outer.signal.addEventListener("abort", release, { once: true });
          await parkWait;
          // Remove the listener: repeated park cycles must not accumulate
          // listeners on the outer signal.
          outer.signal.removeEventListener("abort", release);
          parked = false;
          continue;
        }

        setAutofillStatus("waiting");
        let start;
        try {
          const { passkeyApi, convex } = currentRef.current;
          start = await convex.mutation(passkeyApi.startAutofillSignIn, {});
        } catch (cause) {
          setAutofillLastError(foldClientError(cause));
          setAutofillStatus("stopped");
          return;
        }
        if (pauseCount > 0 || outer.signal.aborted) {
          // The modal flow paused us while the challenge was being
          // fetched: park (at the top of the loop) before a new browser
          // request starts.
          continue;
        }

        inner = new AbortController();
        const innerController = inner;
        const forwardAbort = () =>
          innerController.abort(outer.signal.reason ?? "STOP");
        outer.signal.addEventListener("abort", forwardAbort, { once: true });
        // Refresh before the server's challenge TTL, so the challenge
        // that the user finally redeems is never expired.
        const refreshTimer = setTimeout(
          () => innerController.abort("REFRESH" satisfies AutofillAbortReason),
          AUTOFILL_REFRESH_MS,
        );
        try {
          const credential = (await navigator.credentials.get({
            mediation: "conditional",
            signal: innerController.signal,
            publicKey: {
              challenge: start.challenge,
              rpId: start.rpId,
              userVerification: "required",
              // No allow-list: the passkey the user picks identifies the
              // account.
              allowCredentials: [],
            },
          })) as PublicKeyCredential | null;
          if (credential === null) {
            setAutofillStatus("stopped");
            return;
          }

          setAutofillStatus("signingIn");
          const { passkeyApi, signInApi, setSession } = currentRef.current;
          const result = await signInApi.mutation(
            passkeyApi.finishSignIn,
            assertionArgs(credential),
          );
          if (result.success) {
            // Residual race with the modal flow: when the user resolves
            // the autofill assertion just before the modal flow pauses us,
            // and the modal ceremony also completes, `setSession` runs
            // twice and the last write wins. Both sessions are valid, so
            // this is harmless.
            await setSession(result.tokens);
            // A failed attempt earlier in this loop can have set
            // `lastError`. The sign-in succeeded, so clear it.
            setAutofillLastError(null);
            setAutofillStatus("signedIn");
            return;
          }
          setAutofillLastError(result.userError);
          failures += 1;
          if (failures >= MAX_AUTOFILL_FAILURES) {
            setAutofillStatus("stopped");
            return;
          }
          // Try again with a fresh challenge.
        } catch (error) {
          // Look at the thrown value before the signal: a real failure
          // can race a `PAUSE`/`REFRESH` abort, and the signal alone
          // would misattribute it.
          const reason = autofillAbortReason(error, innerController.signal);
          if (reason === "REFRESH" || reason === "PAUSE") {
            // The top of the loop starts a fresh request, or parks until
            // `resume()`.
            continue;
          }
          if (reason === "STOP") {
            return; // The hook unmounted or `cancel()` ran.
          }
          // Includes `NotAllowedError` (a permissions-policy refusal or
          // another pending request, e.g. from a second `usePasskey`
          // instance): retrying would spin, so stop for good.
          // `foldClientError` maps it to `CEREMONY_ABORTED`.
          setAutofillLastError(foldClientError(error));
          setAutofillStatus("stopped");
          return;
        } finally {
          clearTimeout(refreshTimer);
          outer.signal.removeEventListener("abort", forwardAbort);
          inner = null;
        }
      }
    };

    void run().finally(() => {
      // Never leave a `pause()` caller hanging, whatever path exited the
      // loop.
      onParked?.();
      onParked = null;
      // Retract the handle, unless a newer effect run published its own.
      if (autofillHandleRef.current === handle) {
        autofillHandleRef.current = null;
      }
    });

    return () => {
      if (typeof document !== "undefined") {
        document.removeEventListener("visibilitychange", onVisibilityChange);
      }
      outer.abort("STOP" satisfies AutofillAbortReason);
    };
  }, [autofillEnabled]);

  const cancelAutofill = useCallback(() => {
    cancelAutofillRef.current();
    setAutofillStatus("stopped");
  }, []);

  return {
    /**
     * Runs the identifier-first passkey flow for the given username.
     *
     * Returns an object with a `success` boolean flag.
     *
     * If it is `true` the sign-in (or the account creation) was successful
     * and the client will establish an authenticated session with the
     * Convex backend server. The `flow` field tells which one it was:
     * `"signUp"` created a new account, `"signIn"` authenticated an
     * existing one.
     *
     * If it is `false` the returned object will have a `userError` field
     * with additional details about why sign-in failed.
     */
    signIn,
    /** `true` while a `signIn` attempt is running. */
    pending,
    /** The autofill flow's state. */
    autofill: {
      /**
       * Whether the browser can offer passkeys in the autocompletion
       * list. `null` while detection runs; `false` when autofill is off.
       */
      available: autofillAvailable,
      /** The state of the request; see {@link PasskeyAutofillStatus}. */
      status: autofillStatus,
      /** The most recent failure, for display or logging. */
      lastError: autofillLastError,
      /** Stop the pending autofill request for good. */
      cancel: cancelAutofill,
    },
  };
}
