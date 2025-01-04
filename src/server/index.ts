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
  getAuthUserId,
  getAuthSessionId,
  createAccount,
  retrieveAccount,
  signInViaProvider,
  invalidateSessions,
  modifyAccountCredentials,
  Tokens,
  Doc,
  SignInAction,
  SignOutAction,
  IsAuthenticatedQuery,
} from "./implementation/index.js";
export type {
  ConvexAuthConfig,
  AuthProviderConfig,
  EmailConfig,
  EmailUserConfig,
  PhoneConfig,
  PhoneUserConfig,
  ConvexCredentialsConfig,
  GenericActionCtxWithAuthConfig,
  AuthProviderMaterializedConfig,
  ConvexAuthMaterializedConfig,
} from "./types.js";
export type { GenericDoc } from "./convex_types.js";
