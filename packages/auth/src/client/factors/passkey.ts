/**
 * Platform-neutral passkey (WebAuthn) client core.
 *
 * Owns the two-phase server handshake shared by every platform: request the
 * ceremony options, run the platform's WebAuthn ceremony via the injected
 * {@link PasskeyCeremony} hook, then submit the ceremony result. Platform
 * entrypoints (`browser`, `expo`) supply only the ceremony.
 *
 * @module
 */

import type {
  FactorDeps,
  PasskeyClient,
  PasskeyRegisterOptions,
  PasskeySignInOptions,
  SignInActionResult,
  SignInResult,
} from "../core/types";

/**
 * Platform-specific WebAuthn ceremony hooks. Each returns the phase-2 params
 * submitted to the server verifier for the corresponding flow.
 *
 * @internal
 */
export interface PasskeyCeremony {
  /** Runtime capability probes surfaced on the {@link PasskeyClient}. */
  isSupported(): boolean;
  isAutofillSupported(): Promise<boolean>;
  /**
   * Run the credential-creation ceremony for the given server options and
   * registration hints, returning the phase-2 verification params.
   */
  register(
    options: Record<string, unknown>,
    opts: PasskeyRegisterOptions | undefined,
  ): Promise<Record<string, unknown>>;
  /**
   * Run the credential-assertion ceremony for the given server options and
   * sign-in hints, returning the phase-2 verification params.
   */
  signIn(
    options: Record<string, unknown>,
    opts: PasskeySignInOptions | undefined,
  ): Promise<Record<string, unknown>>;
}

/**
 * Build the platform-neutral passkey client around a platform ceremony.
 *
 * @internal
 */
export function createPasskeyClientCore(
  deps: FactorDeps,
  ceremony: PasskeyCeremony,
): PasskeyClient {
  const { proxy, convex, requireApiRefs, proxyFetch, setTokenAndMaybeWait } = deps;

  const requestSignIn = async (
    params: Record<string, unknown>,
    verifier?: string,
  ): Promise<SignInActionResult> => {
    if (proxy) {
      return (await proxyFetch({
        action: "auth:signIn",
        args: { provider: "passkey", params, ...(verifier ? { verifier } : {}) },
      })) as SignInActionResult;
    }
    return (await convex.action(requireApiRefs().signIn, {
      provider: "passkey",
      params,
      ...(verifier ? { verifier } : {}),
    })) as SignInActionResult;
  };

  const handleSignedInResult = async (
    result: SignInActionResult,
    flow: string,
  ): Promise<SignInResult> => {
    if (result.kind !== "signedIn") {
      return { kind: "started" as const };
    }

    const sessionEstablished = await setTokenAndMaybeWait(
      proxy
        ? {
            shouldStore: false as const,
            tokens: result.session === null ? null : { token: result.session.token },
            waitForHandshake: true,
            context: { provider: "passkey", flow },
          }
        : {
            shouldStore: true as const,
            tokens: result.session,
            waitForHandshake: true,
            context: { provider: "passkey", flow },
          },
    );

    return sessionEstablished
      ? ({ kind: "signedIn" as const } satisfies SignInResult)
      : ({ kind: "started" as const } satisfies SignInResult);
  };

  return {
    isSupported: () => ceremony.isSupported(),
    isAutofillSupported: () => ceremony.isAutofillSupported(),

    register: async (opts?: PasskeyRegisterOptions): Promise<SignInResult> => {
      const phase1 = await requestSignIn({
        flow: "register",
        email: opts?.email,
        userName: opts?.userName,
        userDisplayName: opts?.userDisplayName,
      });
      if (phase1.kind !== "passkeyOptions") {
        throw new Error("Server did not return passkey registration options");
      }
      const phase2Params = await ceremony.register(phase1.options, opts);
      const phase2 = await requestSignIn(phase2Params, phase1.verifier);
      return handleSignedInResult(phase2, "verify");
    },

    signIn: async (opts?: PasskeySignInOptions): Promise<SignInResult> => {
      const phase1 = await requestSignIn({ flow: "signIn", email: opts?.email });
      if (phase1.kind !== "passkeyOptions") {
        throw new Error("Server did not return passkey authentication options");
      }
      const phase2Params = await ceremony.signIn(phase1.options, opts);
      const phase2 = await requestSignIn(phase2Params, phase1.verifier);
      return handleSignedInResult(phase2, "verify");
    },
  };
}
