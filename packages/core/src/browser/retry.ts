/**
 * Retry policy for the client's HTTP auth calls. `AuthClient.fetchAccessToken`
 * uses it for the session refresh in both session modes, and the Next.js
 * client uses it for each call to the sign-in proxy. These calls commonly
 * fail on mobile when the app goes to the background during a request, and
 * succeed once it returns to the foreground. So a network error is worth a
 * couple of retries before the call fails.
 */

/** Retry after this much time (ms), based on the retry number. */
const RETRY_BACKOFF = [500, 2000];
const RETRY_JITTER = 100;

/**
 * Whether `error` looks like a fetch-level network failure. The message test
 * covers the wording used by Chromium, Firefox, and WebKit.
 */
function isNetworkError(error: unknown): boolean {
  return (
    error instanceof TypeError &&
    /network|failed to fetch|load failed/i.test(error.message)
  );
}

/**
 * Run `fn`, retrying with backoff when it throws a network error. Any other
 * error, or a network error persisting past the last retry, is rethrown.
 */
export async function retryOnNetworkError<T>(
  fn: () => Promise<T>,
  log?: (message: string) => void,
): Promise<T> {
  for (const [retry, backoff] of RETRY_BACKOFF.entries()) {
    try {
      return await fn();
    } catch (error) {
      if (!isNetworkError(error)) {
        throw error;
      }
      const wait = backoff + RETRY_JITTER * Math.random();
      log?.(`network error, retry ${retry + 1} in ${wait}ms`);
      await new Promise((resolve) => setTimeout(resolve, wait));
    }
  }
  // All backoffs are used up, so this last attempt's outcome is final
  // either way.
  return await fn();
}
