const NETWORK_ERROR_PATTERN = /(network|fetch|load failed|failed to fetch)/i;

type ProxyErrorBody = {
  error?: string;
  authError?: unknown;
};

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
