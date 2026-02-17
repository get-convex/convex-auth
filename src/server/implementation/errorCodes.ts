export const AuthErrorCode = {
  // Credential verification
  INVALID_CREDENTIALS: "INVALID_CREDENTIALS",
  ACCOUNT_NOT_FOUND: "ACCOUNT_NOT_FOUND",

  // Verification codes
  INVALID_CODE: "INVALID_CODE",
  EXPIRED_CODE: "EXPIRED_CODE",
  INVALID_VERIFIER: "INVALID_VERIFIER",
  ACCOUNT_DELETED: "ACCOUNT_DELETED",
  PROVIDER_MISMATCH: "PROVIDER_MISMATCH",

  // Rate limiting
  RATE_LIMITED: "RATE_LIMITED",

  // Session/refresh
  INVALID_REFRESH_TOKEN: "INVALID_REFRESH_TOKEN",
  EXPIRED_SESSION: "EXPIRED_SESSION",

  // OAuth
  OAUTH_FAILED: "OAUTH_FAILED",

  // Catch-all
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

