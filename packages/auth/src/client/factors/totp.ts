import type { FactorDeps, SignInActionResult, SignInResult, TotpClient } from "../core/types";
import { ErrorCode } from "../../shared/codes";

function isSignedInResult(
  result: SignInActionResult,
): result is Extract<SignInActionResult, { kind: "signedIn" }> {
  return result.kind === "signedIn";
}

function isTotpSetupResult(
  result: SignInActionResult,
): result is Extract<SignInActionResult, { kind: "totpSetup" }> {
  return result.kind === "totpSetup";
}

/** @internal */
export function createTotpClient(deps: FactorDeps): TotpClient {
  const { proxy, convex, requireApiRefs, proxyFetch, setTokenAndMaybeWait } = deps;

  const completeSignIn = async (
    result: SignInActionResult,
    flow: "confirm" | "verify",
  ): Promise<SignInResult> => {
    if (!isSignedInResult(result) || !result.session) {
      return { kind: "failed", code: ErrorCode.TOTP_INVALID_CODE };
    }
    const established = await setTokenAndMaybeWait(
      proxy
        ? {
            shouldStore: false,
            tokens: { token: result.session.token },
            waitForHandshake: true,
            context: { provider: "totp", flow },
          }
        : {
            shouldStore: true,
            tokens: result.session,
            waitForHandshake: true,
            context: { provider: "totp", flow },
          },
    );
    return established ? { kind: "signedIn" } : { kind: "started" };
  };

  return {
    setup: async (opts?: {
      name?: string;
      accountName?: string;
    }): Promise<{
      uri: string;
      secret: string;
      verifier: string;
      totpId: string;
    }> => {
      const params: Record<string, unknown> = { flow: "setup" };
      if (opts?.name) params.name = opts.name;
      if (opts?.accountName) params.accountName = opts.accountName;

      if (proxy) {
        const result = (await proxyFetch({
          action: "auth:signIn",
          args: { provider: "totp", params },
        })) as SignInActionResult;
        if (!isTotpSetupResult(result)) {
          throw new Error("Server did not return TOTP setup data.");
        }
        return {
          uri: result.totpSetup.uri,
          secret: result.totpSetup.secret,
          verifier: result.verifier,
          totpId: result.totpSetup.totpId,
        };
      }

      const result = (await convex.action(requireApiRefs().signIn, {
        provider: "totp",
        params,
      })) as SignInActionResult;
      if (!isTotpSetupResult(result)) {
        throw new Error("Server did not return TOTP setup data.");
      }
      return {
        uri: result.totpSetup.uri,
        secret: result.totpSetup.secret,
        verifier: result.verifier,
        totpId: result.totpSetup.totpId,
      };
    },

    confirm: async (opts: {
      code: string;
      verifier: string;
      totpId: string;
    }): Promise<SignInResult> => {
      const params: Record<string, unknown> = {
        flow: "verify",
        code: opts.code,
        totpId: opts.totpId,
      };

      const result = (
        proxy
          ? await proxyFetch({
              action: "auth:signIn",
              args: { provider: "totp", params, verifier: opts.verifier },
            })
          : await convex.action(requireApiRefs().signIn, {
              provider: "totp",
              params,
              verifier: opts.verifier,
            })
      ) as SignInActionResult;
      return completeSignIn(result, "confirm");
    },

    verify: async (opts: { code: string; verifier: string }): Promise<SignInResult> => {
      const params: Record<string, unknown> = {
        flow: "verify",
        code: opts.code,
      };

      const result = (
        proxy
          ? await proxyFetch({
              action: "auth:signIn",
              args: { provider: "totp", params, verifier: opts.verifier },
            })
          : await convex.action(requireApiRefs().signIn, {
              provider: "totp",
              params,
              verifier: opts.verifier,
            })
      ) as SignInActionResult;
      return completeSignIn(result, "verify");
    },
  };
}
