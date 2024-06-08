export {
  tables,
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
