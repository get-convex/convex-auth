"use client";

import { Value } from "convex/values";
import { useCallback, useContext, useRef } from "react";
import { ConvexAuthActionsContext } from "./client.js";

/**
 * The result of {@link usePasskeyAuth}.
 */
export type PasskeyAuthActions = {
  /**
   * Register a new passkey and sign up (or, if a user is already signed in,
   * add the passkey to their account).
   *
   * Drives the full WebAuthn ceremony: fetches registration options from the
   * server, prompts the authenticator via `@simplewebauthn/browser`, and
   * verifies the result.
   *
   * @param params Extra params forwarded to `signIn`. Pass `email` and/or
   *               `name` so a brand new user can be created.
   */
  registerPasskey: (
    params?: Record<string, Value>,
  ) => Promise<{ signingIn: boolean }>;
  /**
   * Sign in with an existing passkey.
   *
   * Drives the full WebAuthn ceremony: fetches authentication options from the
   * server, prompts the authenticator via `@simplewebauthn/browser`, and
   * verifies the result.
   */
  signInWithPasskey: (
    params?: Record<string, Value>,
  ) => Promise<{ signingIn: boolean }>;
  /**
   * Whether this browser supports passkey autofill (conditional mediation).
   *
   * Use it to decide whether to render an autofill-enabled sign-in field and
   * call {@link startConditionalPasskeySignIn}.
   */
  isConditionalPasskeySupported: () => Promise<boolean>;
  /**
   * Start a passkey autofill (conditional mediation) request.
   *
   * Call this once when your sign-in form mounts, and render an input with
   * `autoComplete="username webauthn"`. The browser/password manager then
   * surfaces the passkeys that exist on the device in that field's autofill
   * dropdown; selecting one signs the user in — no "what's a passkey?" button
   * and no need to remember which email was used.
   *
   * The returned promise resolves once the user picks a passkey (or rejects on
   * error). It is a no-op (resolving with `{ supported: false }`) on browsers
   * without autofill support, and is safe to call repeatedly — a single
   * conditional request is kept in flight at a time.
   */
  startConditionalPasskeySignIn: (
    params?: Record<string, Value>,
  ) => Promise<{ supported: boolean; signingIn?: boolean }>;
};

/**
 * Use this hook to register and sign in with passkeys.
 *
 * Requires a {@link "@convex-dev/auth/providers/Passkey"!Passkey} provider
 * configured on the server.
 *
 * ```tsx
 * import { usePasskeyAuth } from "@convex-dev/auth/react";
 *
 * function SignIn() {
 *   const { registerPasskey, signInWithPasskey } = usePasskeyAuth();
 *   return (
 *     <>
 *       <button onClick={() => signInWithPasskey()}>Sign in</button>
 *       <button onClick={() => registerPasskey({ email })}>Sign up</button>
 *     </>
 *   );
 * }
 * ```
 *
 * For the smoothest experience, drive sign-in via autofill (conditional
 * mediation) instead of a button:
 *
 * ```tsx
 * function SignIn() {
 *   const { startConditionalPasskeySignIn } = usePasskeyAuth();
 *   useEffect(() => {
 *     void startConditionalPasskeySignIn();
 *   }, [startConditionalPasskeySignIn]);
 *   return <input name="email" autoComplete="username webauthn" />;
 * }
 * ```
 *
 * @param provider The id of your Passkey provider. Defaults to `"passkey"`.
 */
export function usePasskeyAuth(provider: string = "passkey"): PasskeyAuthActions {
  const { signIn } = useContext(ConvexAuthActionsContext);
  // Keeps a single conditional-mediation request in flight (React Strict Mode
  // mounts effects twice, and the browser allows only one at a time).
  const conditionalInFlight = useRef(false);

  const registerPasskey = useCallback(
    async (params?: Record<string, Value>) => {
      const { data: options } = await signIn(provider, {
        ...params,
        flow: "registrationOptions",
      });
      if (options === undefined) {
        throw new Error(
          "The Passkey provider did not return registration options. " +
            "Is it configured on the server?",
        );
      }
      const { startRegistration } = await import("@simplewebauthn/browser");
      const response = await startRegistration(options as any);
      return await signIn(provider, {
        ...params,
        flow: "registration",
        response: JSON.stringify(response),
      });
    },
    [signIn, provider],
  );

  const signInWithPasskey = useCallback(
    async (params?: Record<string, Value>) => {
      const { data: options } = await signIn(provider, {
        ...params,
        flow: "authenticationOptions",
      });
      if (options === undefined) {
        throw new Error(
          "The Passkey provider did not return authentication options. " +
            "Is it configured on the server?",
        );
      }
      const { startAuthentication } = await import("@simplewebauthn/browser");
      const response = await startAuthentication(options as any);
      return await signIn(provider, {
        ...params,
        flow: "authentication",
        response: JSON.stringify(response),
      });
    },
    [signIn, provider],
  );

  const isConditionalPasskeySupported = useCallback(async () => {
    const { browserSupportsWebAuthnAutofill } = await import(
      "@simplewebauthn/browser"
    );
    return browserSupportsWebAuthnAutofill();
  }, []);

  const startConditionalPasskeySignIn = useCallback(
    async (params?: Record<string, Value>) => {
      if (conditionalInFlight.current) {
        return { supported: true };
      }
      conditionalInFlight.current = true;
      try {
        const { browserSupportsWebAuthnAutofill, startAuthentication } =
          await import("@simplewebauthn/browser");
        if (!(await browserSupportsWebAuthnAutofill())) {
          conditionalInFlight.current = false;
          return { supported: false };
        }
        const { data: options } = await signIn(provider, {
          ...params,
          flow: "authenticationOptions",
        });
        if (options === undefined) {
          throw new Error(
            "The Passkey provider did not return authentication options. " +
              "Is it configured on the server?",
          );
        }
        // The second argument enables conditional mediation (autofill UI).
        const response = await startAuthentication(options as any, true);
        const result = await signIn(provider, {
          ...params,
          flow: "authentication",
          response: JSON.stringify(response),
        });
        return { supported: true, signingIn: result.signingIn };
      } catch (error) {
        // Allow a later retry (e.g. the user dismissed the autofill prompt).
        conditionalInFlight.current = false;
        throw error;
      }
    },
    [signIn, provider],
  );

  return {
    registerPasskey,
    signInWithPasskey,
    isConditionalPasskeySupported,
    startConditionalPasskeySignIn,
  };
}
