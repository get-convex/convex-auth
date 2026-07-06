import { ConvexError } from "convex/values";

import { ErrorCode } from "../shared/codes";
import { AuthFlowError } from "../shared/errors";

export type AuthErrorData = {
  code: ErrorCode;
  message: string;
};

/**
 * Build a `ConvexError` carrying an auth error `code` and `message`, plus any
 * extra structured fields.
 * @internal
 */
export const convexError = (
  code: ErrorCode,
  message: string,
  extra?: Record<string, unknown>,
): ConvexError<AuthErrorData> => new ConvexError({ code, message, ...extra });

/** @internal */
export const toConvexError = (error: unknown): ConvexError<AuthErrorData> => {
  if (error instanceof ConvexError) {
    return error as ConvexError<AuthErrorData>;
  }
  if (error instanceof AuthFlowError) {
    /**
     * `AuthFlowError.code` is the wider client/server flow-code space (e.g. the
     * RFC 8628 device codes `DEVICE_SLOW_DOWN`/`DEVICE_AUTHORIZATION_PENDING`),
     * which is a superset of the {@link ErrorCode} registry. This is the single
     * adapter that bridges that wider space into {@link AuthErrorData}.
     */
    return new ConvexError({ code: error.code as ErrorCode, message: error.message });
  }
  return new ConvexError({
    code: ErrorCode.INTERNAL_ERROR,
    message: error instanceof Error ? error.message : String(error),
  });
};
