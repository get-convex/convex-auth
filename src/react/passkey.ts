"use client";

import { Value } from "convex/values";
import { useCallback, useContext } from "react";
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
 * @param provider The id of your Passkey provider. Defaults to `"passkey"`.
 */
export function usePasskeyAuth(provider: string = "passkey"): PasskeyAuthActions {
  const { signIn } = useContext(ConvexAuthActionsContext);

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

  return { registerPasskey, signInWithPasskey };
}
