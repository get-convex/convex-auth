/**
 * Framework-agnostic server (SSR) building blocks for Convex Auth: a cookie
 * abstraction, access-token inspection, and the {@link ServerAuthSession} that
 * ties them together. The Next.js bindings (`@convex-dev/auth/nextjs/server`)
 * build on these, and other SSR frameworks can too.
 *
 * @module
 */

export {
  type CookieOptions,
  type CookieStore,
  AUTH_JWT_COOKIE,
  AUTH_REFRESH_COOKIE,
  defaultCookieOptions,
} from "./cookies";
export {
  type DecodedAccessToken,
  decodeAccessToken,
  isTokenExpiring,
} from "./jwt";
export { ServerAuthSession, type ServerAuthSessionConfig } from "./session";
export type { AuthApi } from "../browser/sessionManager";
export type { TokenBundle } from "../lib/types";
