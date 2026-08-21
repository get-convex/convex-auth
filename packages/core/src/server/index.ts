/**
 * Framework-agnostic server (SSR) building blocks for Convex Auth: a cookie
 * abstraction, a WHATWG `Request`/`Response` cookie adapter, access-token
 * inspection, the {@link ServerAuthSession} that owns the refresh lifecycle,
 * the {@link createServerAuthChecker} that verifies an access token against the
 * backend, the provider-agnostic `(Request) => Response` refresh/sign-out
 * handlers, the {@link convexProxyHandler} that serves sign-in, and the
 * {@link setupConvexAuthServer} factory that configures them all once.
 *
 * @module
 */

export {
  type AuthCookieOptions,
  type CookieDeleteOptions,
  type CookieOptions,
  type CookieStore,
  AUTH_JWT_COOKIE,
  AUTH_REFRESH_COOKIE,
  clearAuthCookies,
  writeAuthCookies,
} from "./cookies.js";
export {
  type HttpCookies,
  httpCookies,
  serializeCookie,
} from "./httpCookies.js";
export { isTrustedOrigin } from "./origin.js";
export {
  type RefreshHandlerConfig,
  type RequestHandler,
  type SignOutHandlerConfig,
  refreshHandler,
  signOutHandler,
} from "./handlers.js";
export { type ConvexAuthServerConfig, setupConvexAuthServer } from "./setup.js";
export {
  type ConvexProxyConfig,
  type ExposedSignInFn,
  convexProxyHandler,
} from "./signInProxy.js";
export {
  type DecodedAccessToken,
  decodeAccessToken,
  isTokenExpiring,
} from "./jwt.js";
export {
  ServerAuthSession,
  type RefreshSession,
  type ServerAuthSessionConfig,
} from "./session.js";
export {
  createServerAuthChecker,
  type ServerAuthChecker,
  type ServerAuthCheckerConfig,
} from "./isAuthenticated.js";
export type {
  AuthSessionResponse,
  ClientView,
  ConvexAuthApi,
  IsAuthenticatedFn,
  RefreshSessionFn,
  SignInSuccess,
  SignOutFn,
  SlimTokenBundle,
  TokenBundle,
} from "../lib/types.js";
export { makeSlimBundle, vSignInSuccess } from "../lib/types.js";
