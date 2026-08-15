/**
 * Framework-agnostic browser building blocks for Convex Auth clients: a token
 * storage abstraction, a cross-tab refresh mutex, and the session manager that
 * ties them together. The React bindings (`@convex-dev/auth/react`) build on
 * these, and other client libraries can too.
 */

export {
  type TokenStorage,
  type ScopedStorage,
  InMemoryStorage,
  defaultStorage,
  JWT_STORAGE_KEY,
  REFRESH_TOKEN_STORAGE_KEY,
} from "./storage";
export { runWithMutex } from "./mutex";
export { KeyedStore, scopedKey, type ScopedKeyedStore } from "./keyedStore";
export type {
  AuthProviderClientContext,
  AuthProviderClientSetup,
  AuthSignInApi,
} from "./providerSetup";
export {
  AuthClient,
  type SpaAuthApi,
  type SsrAuthApi,
  type AuthClientConfig,
  type AuthState,
} from "./sessionManager";
