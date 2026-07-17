/**
 * Framework-agnostic server (SSR) building blocks for Convex Auth: a cookie
 * abstraction, a WHATWG `Request`/`Response` cookie adapter, access-token
 * inspection, the {@link ServerAuthSession} that ties them together, and the
 * provider-agnostic `(Request) => Response` refresh/sign-out handlers.
 *
 * @module
 */

export {
  type AuthCookieOptions,
  type CookieOptions,
  type CookieStore,
  AUTH_JWT_COOKIE,
  AUTH_REFRESH_COOKIE,
  clearAuthCookies,
  writeAuthCookies,
} from "./cookies";
export { type HttpCookies, httpCookies, serializeCookie } from "./httpCookies";
export {
  type RefreshHandlerConfig,
  type RequestHandler,
  type SignOutHandlerConfig,
  refreshHandler,
  signInResponse,
  signOutHandler,
} from "./handlers";
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
export type {
  ConvexAuthApi,
  RefreshSessionFn,
  SignOutFn,
  SlimTokenBundle,
  TokenBundle,
} from "../lib/types";
export { makeSlimBundle } from "../lib/types";
