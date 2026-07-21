/**
 * Framework-agnostic server (SSR) building blocks for Convex Auth: a cookie
 * abstraction, access-token inspection, and the {@link ServerAuthSession} that
 * ties them together.
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
