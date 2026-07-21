import { ConvexError } from "convex/values";

import { ErrorCode } from "../../shared/codes";

const NETWORK_ERROR_PATTERN = /(network|fetch|load failed|failed to fetch)/i;

type ProxyErrorBody = {
  error?: string;
  authError?: unknown;
};

/**
 * Error codes that mean a forced refresh was definitively rejected — the
 * presented refresh credential is invalid, so the session must be signed out
 * rather than retried. Mirrors the server's refresh classification, which
 * clears cookies only on {@link ErrorCode.INVALID_REFRESH_TOKEN}.
 */
const AUTH_REFRESH_REJECTION_CODES = new Set<string>([
  ErrorCode.INVALID_REFRESH_TOKEN,
  ErrorCode.OAUTH_INVALID_REFRESH_TOKEN,
  ErrorCode.INVALID_VERIFIER,
]);

/**
 * Error thrown when a proxy request returns a non-OK HTTP response. Carries the
 * HTTP `status` structurally so retriability is classified without re-parsing a
 * formatted message.
 *
 * @internal
 */
export class ProxyRequestError extends Error {
  readonly status: number;
  constructor(status: number, message?: string) {
    super(message ?? `Proxy request failed: ${status}`);
    this.name = "ProxyRequestError";
    this.status = status;
  }
}

/** @internal */
export function isTransientNetworkError(error: unknown): boolean {
  return (
    error instanceof TypeError ||
    (error instanceof Error && NETWORK_ERROR_PATTERN.test(error.message || ""))
  );
}

/** @internal */
export function isRetriableProxyRefreshError(error: unknown): boolean {
  if (isTransientNetworkError(error)) {
    return true;
  }
  if (!(error instanceof ProxyRequestError)) {
    return false;
  }
  const { status } = error;
  return status === 429 || (status >= 500 && status < 600);
}

/**
 * Classify whether a forced-refresh failure is a definitive credential
 * rejection (the session must be signed out) rather than a transient/network
 * failure (the session should be kept so a later forced refresh can recover).
 *
 * A proxy `401`/`403` and a structured {@link ConvexError} carrying an
 * invalid-refresh code are treated as sign-out; everything else (network
 * errors, `429`, `5xx`, unknown shapes) is treated as transient. This mirrors
 * the server, which clears the session only on an explicit auth rejection.
 *
 * @internal
 */
export function isAuthRefreshRejection(error: unknown): boolean {
  if (error instanceof ProxyRequestError) {
    return error.status === 401 || error.status === 403;
  }
  if (error instanceof ConvexError) {
    const code = (error.data as { code?: unknown } | null | undefined)?.code;
    return typeof code === "string" && AUTH_REFRESH_REJECTION_CODES.has(code);
  }
  return false;
}

/** @internal */
export function parseProxyErrorBody(value: unknown): ProxyErrorBody {
  if (typeof value !== "object" || value === null) {
    return {};
  }
  const obj = value as Record<string, unknown>;
  return {
    error: typeof obj.error === "string" ? obj.error : undefined,
    authError: obj.authError,
  };
}
