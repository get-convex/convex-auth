/**
 * A framework-agnostic cookie abstraction for server-side (SSR) auth.
 *
 * SSR frameworks each expose cookies differently — Next.js has `NextRequest`/
 * `NextResponse` cookies in middleware and `next/headers` `cookies()` in route
 * handlers and server components; other frameworks have their own. This module
 * defines the small interface the shared {@link ServerAuthSession} needs, so a
 * framework binding only has to adapt its cookies to {@link CookieStore}.
 *
 * Nothing here depends on React, Next.js, or Convex.
 *
 * @module
 */

import { JWT_STORAGE_KEY, REFRESH_TOKEN_STORAGE_KEY } from "../browser/storage";
import type { TokenBundle } from "../lib/types";

/** The cookie holding the current access token (a JWT). */
export const AUTH_JWT_COOKIE = JWT_STORAGE_KEY;
/** The cookie holding the current (rotating) refresh token. */
export const AUTH_REFRESH_COOKIE = REFRESH_TOKEN_STORAGE_KEY;

/** Attributes applied when writing a cookie. */
export interface CookieOptions {
  /** Whether to hide the cookie from client JS. */
  httpOnly?: boolean;
  /** Whether to send only over HTTPS. */
  secure?: boolean;
  /** CSRF posture. Defaults to `"lax"`. */
  sameSite?: "lax" | "strict" | "none";
  /** Cookie path. Defaults to `"/"`. */
  path?: string;
  /** Max age in seconds. */
  maxAge?: number;
  /** Absolute expiry. */
  expires?: Date;
  /** Cookie domain. */
  domain?: string;
}

/**
 * Read/write/delete cookies. Every method may be synchronous or return a
 * promise, so request/response cookie APIs that are async (e.g. `next/headers`
 * `cookies()`) work without ceremony.
 */
export interface CookieStore {
  /** Read a cookie value. */
  get: (name: string) => string | undefined | Promise<string | undefined>;
  /** Write a cookie. */
  set: (
    name: string,
    value: string,
    options?: CookieOptions,
  ) => void | Promise<void>;
  /** Delete a cookie. */
  delete: (name: string) => void | Promise<void>;
}

/**
 * The default attributes for auth cookies.
 *
 *  * `httpOnly: true` (so the refresh token never reaches client JS)
 *  * `sameSite: "lax"` to aid in CSRF protection (see
 *     https://auth.pilcrowonpaper.com/csrf)
 *  * `path: "/"` so the cookies will be sent for all paths on the site
 */
export function defaultCookieOptions(): CookieOptions {
  return {
    httpOnly: true,
    sameSite: "lax",
    path: "/",
  };
}

/**
 * Write a session's tokens as cookies: the access token in
 * {@link AUTH_JWT_COOKIE} and the refresh token in {@link AUTH_REFRESH_COOKIE}.
 * Both live as long as the refresh token (the access token is refreshed on
 * expiry). With {@link defaultCookieOptions} the refresh cookie is httpOnly, so
 * it never reaches client JS.
 *
 * This is the one place that knows which cookies hold a session and how their
 * lifetimes derive from the bundle, so refresh, middleware, and every provider's
 * sign-in handler shape cookies identically.
 */
export async function writeAuthCookies(
  cookies: CookieStore,
  bundle: TokenBundle,
  options: CookieOptions = defaultCookieOptions(),
): Promise<void> {
  const expires = new Date(bundle.refreshTokenExpiresAt);
  await cookies.set(AUTH_JWT_COOKIE, bundle.accessToken, {
    ...options,
    expires,
  });
  await cookies.set(AUTH_REFRESH_COOKIE, bundle.refreshToken, {
    ...options,
    expires,
  });
}

/** Delete both auth cookies. The counterpart of {@link writeAuthCookies}. */
export async function clearAuthCookies(cookies: CookieStore): Promise<void> {
  await cookies.delete(AUTH_JWT_COOKIE);
  await cookies.delete(AUTH_REFRESH_COOKIE);
}
