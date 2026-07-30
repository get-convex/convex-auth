/**
 * Route path conventions shared by the server-side catch-all `handler` and
 * the client hooks, so both sides agree on where each handler is mounted
 * without any per-app coordination.
 *
 * @module
 */

/** Default path prefix the auth routes are mounted under. */
export const AUTH_BASE_PATH = "/auth";

/** Subpath of the refresh handler under the base path. */
export const REFRESH_PATH = "refresh";

/** Subpath of the sign-out handler under the base path. */
export const SIGN_OUT_PATH = "signout";
