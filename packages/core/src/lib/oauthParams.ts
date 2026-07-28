/**
 * The query params the OAuth component's callback appends when it redirects the
 * browser back to the app, and that the browser client reads on mount.
 *
 * They are deliberately namespaced rather than the bare `code`/`error` an OAuth
 * callback would normally use. The client's callback handler is registered
 * unconditionally (every app that uses Convex Auth runs it on mount), so bare
 * names would let it consume `?code=`/`?error=` params from an unrelated flow
 * the app runs itself. A namespaced param is proof the redirect came from this
 * component, which is also what keeps the client's `invalid_flow` detection
 * meaningful.
 *
 * Shared by the component (which writes them) and the browser client (which
 * reads them) so the two ends can never drift.
 *
 * @module
 */

/** Carries the one-time code the client redeems for a session. */
export const OAUTH_CODE_PARAM = "convexAuthCode";

/** Carries a normalized {@link OAuthFlowError} code when the flow failed. */
export const OAUTH_ERROR_PARAM = "convexAuthError";
