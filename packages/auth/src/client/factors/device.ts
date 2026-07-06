import { ConvexError } from "convex/values";

import type { DeviceClient, DevicePollParams, FactorDeps, SignInActionResult } from "../core/types";
import type { AuthTokens } from "../../shared/results";
import { ErrorCode } from "../../shared/codes";

function isSignedInResult(
  result: SignInActionResult,
): result is Extract<SignInActionResult, { kind: "signedIn" }> {
  return result.kind === "signedIn";
}

/** @internal */
export function createDeviceClient(deps: FactorDeps): DeviceClient {
  const { proxy, convex, requireApiRefs, proxyFetch, setTokenAndMaybeWait } = deps;

  const requestDeviceSignIn = async (
    params: Record<string, unknown>,
  ): Promise<SignInActionResult> => {
    return (
      proxy
        ? await proxyFetch({
            action: "auth:signIn",
            args: { provider: "device", params },
          })
        : await convex.action(requireApiRefs().signIn, {
            provider: "device",
            params,
          })
    ) as SignInActionResult;
  };

  return {
    poll: async (opts: DevicePollParams): Promise<void> => {
      const { code, signal } = opts;
      const MAX_POLL_DURATION_MS = 30 * 60 * 1000;
      const SLOW_DOWN_INCREMENT_MS = 5 * 1000;
      let currentIntervalMs = code.interval * 1000;
      const startedAt = Date.now();
      const expiresAt = Math.min(
        startedAt + code.expiresIn * 1000,
        startedAt + MAX_POLL_DURATION_MS,
      );

      while (Date.now() < expiresAt) {
        if (signal?.aborted) return;
        await new Promise((resolve) => setTimeout(resolve, currentIntervalMs));
        if (signal?.aborted) return;

        const params: Record<string, unknown> = {
          flow: "poll",
          deviceCode: code.deviceCode,
        };

        let pollResult: SignInActionResult | null;
        try {
          pollResult = await requestDeviceSignIn(params);
        } catch (error) {
          if (error instanceof ConvexError) {
            const errorCode = (error.data as Record<string, unknown> | undefined)?.code;
            if (errorCode === "DEVICE_AUTHORIZATION_PENDING") {
              continue;
            }
            if (errorCode === "DEVICE_SLOW_DOWN") {
              currentIntervalMs += SLOW_DOWN_INCREMENT_MS;
              continue;
            }
          }
          throw error;
        }

        if (pollResult === null) {
          continue;
        }

        if (isSignedInResult(pollResult) && pollResult.session) {
          if (proxy) {
            await setTokenAndMaybeWait({
              shouldStore: false,
              tokens: pollResult.session === null ? null : { token: pollResult.session.token },
              waitForHandshake: true,
              context: { provider: "device", flow: "poll" },
            });
          } else {
            await setTokenAndMaybeWait({
              shouldStore: true,
              tokens: (pollResult.session as AuthTokens | null) ?? null,
              waitForHandshake: true,
              context: { provider: "device", flow: "poll" },
            });
          }
          return;
        }
      }

      throw new ConvexError({
        code: ErrorCode.DEVICE_CODE_EXPIRED,
        message: "Device code expired before authorization was completed.",
      });
    },

    verify: async (opts: { code: string }): Promise<void> => {
      const params: Record<string, unknown> = {
        flow: "verify",
        userCode: opts.code,
      };

      try {
        await requestDeviceSignIn(params);
      } catch (error) {
        throw new ConvexError({
          code: ErrorCode.DEVICE_AUTHORIZATION_FAILED,
          message: error instanceof Error ? error.message : "Invalid or expired code.",
        });
      }
    },
  };
}
