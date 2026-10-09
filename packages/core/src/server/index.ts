/**
 * The Convex functions of the core, exported at `@convex-dev/auth/ssr`.
 *
 * {@link setupCore} builds the session functions that the app exports.
 * {@link getAuthUserId} reads the user id of the caller in a query, a
 * mutation, or an action.
 *
 * @module
 */

export { setupCore, type AuthCore } from "./setup.ts";
export { getAuthUserId } from "./userId.ts";
