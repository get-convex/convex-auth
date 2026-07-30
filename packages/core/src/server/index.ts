/**
 * Framework-agnostic server (SSR) building blocks for Convex Auth: a cookie
 * abstraction, a WHATWG `Request`/`Response` cookie adapter, access-token
 * inspection, the {@link ServerAuthSession} that owns the refresh lifecycle,
 * the {@link createServerAuthChecker} that verifies an access token against the
 * backend, the provider-agnostic `(Request) => Response` refresh/sign-out
 * handlers, and the {@link setupConvexAuthServer} factory that configures them
 * (and sign-in) once.
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
} from "./cookies";
export { type HttpCookies, httpCookies, serializeCookie } from "./httpCookies";
export { isTrustedOrigin } from "./origin";
export {
  type RefreshHandlerConfig,
  type RequestHandler,
  type SignInOutcome,
  type SignOutHandlerConfig,
  refreshHandler,
  signInResponse,
  signOutHandler,
} from "./handlers";
export {
  type ConvexAuthServerConfig,
  type SignInProvider,
  type SignInRoutes,
  InvalidSignInRequestError,
  setupConvexAuthServer,
} from "./setup";
export { AUTH_BASE_PATH, REFRESH_PATH, SIGN_OUT_PATH } from "../lib/routes";
export {
  type DecodedAccessToken,
  decodeAccessToken,
  isTokenExpiring,
} from "./jwt";
export {
  ServerAuthSession,
  type RefreshSession,
  type ServerAuthSessionConfig,
} from "./session";
export {
  createServerAuthChecker,
  type ServerAuthChecker,
  type ServerAuthCheckerConfig,
} from "./isAuthenticated";
export type {
  ConvexAuthApi,
  IsAuthenticatedFn,
  RefreshSessionFn,
  SignOutFn,
  SlimTokenBundle,
  TokenBundle,
} from "../lib/types";
export { makeSlimBundle } from "../lib/types";
