/**
 * Framework-agnostic browser building blocks for Convex Auth clients: a token
 * storage abstraction, a cross-tab refresh mutex, and the session manager that
 * ties them together. The React bindings (`@convex-dev/auth/react`) build on
 * these, and other client libraries can too.
 */

export {
  type TokenStorage,
  type SignInStorage,
  InMemoryStorage,
  defaultStorage,
  JWT_STORAGE_KEY,
  REFRESH_TOKEN_STORAGE_KEY,
} from "./storage.js";
export { runWithMutex } from "./mutex.js";
export type { SignInValues, SignInValuesReader } from "./keyedStore.js";
export type {
  AmbientSignInClient,
  AmbientSignInContext,
  AuthSignInApi,
} from "./ambientSignInClient.js";
export {
  AuthClient,
  type SpaAuthApi,
  type SsrAuthApi,
  type AuthClientConfig,
  type AuthState,
} from "./sessionManager.js";
