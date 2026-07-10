/**
 * Framework-agnostic browser building blocks for Convex Auth clients: a token
 * storage abstraction, a cross-tab refresh mutex, and the session manager that
 * ties them together. The React bindings (`@convex-dev/auth/react`) build on
 * these, and other client libraries can too.
 */

export {
  type TokenStorage,
  InMemoryStorage,
  NamespacedStorage,
  defaultStorage,
  JWT_STORAGE_KEY,
  REFRESH_TOKEN_STORAGE_KEY,
} from "./storage";
export { browserMutex } from "./mutex";
export {
  AuthClient,
  type AuthApi,
  type AuthClientOptions,
  type AuthState,
} from "./sessionManager";
