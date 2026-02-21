/**
 * Structured error codes returned by auth operations.
 * Use these to identify specific failure reasons and display
 * appropriate messages to users.
 *
 * ```ts
 * import { AuthErrorCode } from "@convex-dev/auth/server";
 * // or
 * import { AuthErrorCode } from "@convex-dev/auth/react";
 * ```
 */
export const AuthErrorCode = {
  /** Wrong password or credential. */
  INVALID_CREDENTIALS: "INVALID_CREDENTIALS",
  /** No account exists for the given identifier. */
  ACCOUNT_NOT_FOUND: "ACCOUNT_NOT_FOUND",

  /** Wrong OTP or verification code. */
  INVALID_CODE: "INVALID_CODE",
  /** OTP or verification code has expired. */
  EXPIRED_CODE: "EXPIRED_CODE",
  /** PKCE verifier mismatch during OAuth. */
  INVALID_VERIFIER: "INVALID_VERIFIER",
  /** Account was deleted. */
  ACCOUNT_DELETED: "ACCOUNT_DELETED",
  /** Verification code was issued by a different provider. */
  PROVIDER_MISMATCH: "PROVIDER_MISMATCH",

  /** Too many failed attempts. */
  RATE_LIMITED: "RATE_LIMITED",

  /** Refresh token is invalid or was already used. */
  INVALID_REFRESH_TOKEN: "INVALID_REFRESH_TOKEN",
  /** Session has expired. */
  EXPIRED_SESSION: "EXPIRED_SESSION",

  /** OAuth callback failed. */
  OAUTH_FAILED: "OAUTH_FAILED",

  /** Unexpected internal error. */
  INTERNAL_ERROR: "INTERNAL_ERROR",
} as const;

export type AuthErrorCode = (typeof AuthErrorCode)[keyof typeof AuthErrorCode];

export function isAuthError(
  result: unknown,
): result is { error: AuthErrorCode } {
  return result !== null && typeof result === "object" && "error" in result;
}

/**
 * Thrown internally when an auth operation fails.
 * Carries both the structured error code and the legacy message string
 * for backwards-compatible error handling.
 */
export class AuthError extends Error {
  constructor(
    public readonly code: AuthErrorCode,
    /**
     * @deprecated Legacy message for use by `legacyOnAuthError` only.
     * Do not use in new code.
     */
    public readonly legacyMessage: string | null,
  ) {
    super(code);
  }
}

const AUTH_ERROR_CODES = new Set<string>(Object.values(AuthErrorCode));

export function extractAuthError(
  error: unknown,
): { code: AuthErrorCode; legacyMessage: string | null } | null {
  if (error instanceof AuthError) {
    return { code: error.code, legacyMessage: error.legacyMessage };
  }
  if (error instanceof Error && AUTH_ERROR_CODES.has(error.message)) {
    return { code: error.message as AuthErrorCode, legacyMessage: null };
  }
  return null;
}

