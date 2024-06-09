/**
 * Configuration and helpers for using Convex Auth on your Convex
 * backend.
 *
 * Call {@link convexAuth} to configure your authentication methods
 * and use the helpers it returns.
 *
 * Include {@link authTables} in your schema.
 *
 * @module
 */

export {
  authTables,
  convexAuth,
  createAccountWithCredentials,
  retrieveAccountWithCredentials,
  signInViaProvider,
  invalidateSessions,
  modifyAccountCredentials,
  retrieveAccount,
} from "./implementation";
export type {
  ConvexAuthConfig,
  GenericActionCtxWithAuthConfig,
  AuthProviderMaterializedConfig,
  ConvexAuthMaterializedConfig,
} from "./types";
export type { GenericDoc } from "./convex_types";
