/**
 * The framework-agnostic owner of an auth session on the server (SSR).
 *
 * Where the browser {@link AuthClient} keeps the session in `localStorage` and
 * holds the refresh token in client JS, the server keeps it in cookies — the
 * refresh token in an httpOnly cookie that never reaches the browser. This
 * class orchestrates reading those cookies, refreshing the access token against
 * the server when it is missing or near expiry, and writing the rotated tokens
 * back as cookies.
 *
 * It takes an injected `refreshSession` callback, so it never imports Convex: a
 * framework binding supplies one on top of an HTTP client and a
 * {@link CookieStore} built on its request/response cookies, and tests supply a
 * fake. The server can access the real refresh token (from the cookie), so it
 * always passes a `refreshToken` and gets back a full {@link TokenBundle} to
 * re-cookie. Signing out is a separate concern (see the `signOutHandler`), so it
 * is not part of this class.
 *
 * @module
 */

import type { TokenBundle } from "../lib/types";
import {
  AUTH_JWT_COOKIE,
  AUTH_REFRESH_COOKIE,
  CookieOptions,
  CookieStore,
  clearAuthCookies,
  defaultCookieOptions,
  writeAuthCookies,
} from "./cookies";
import { isTokenExpiring } from "./jwt";

/**
 * Rotate a refresh token into a fresh {@link TokenBundle}, or `null` when the
 * session is gone (unknown or expired refresh token). A framework binding
 * usually implements this over a Convex HTTP client; tests pass a fake.
 */
export type RefreshSession = (
  refreshToken: string,
) => Promise<TokenBundle | null>;

/** Configuration for a {@link ServerAuthSession}. */
export interface ServerAuthSessionConfig {
  /** Exchange the cookie's refresh token for a fresh session (typically over a
   * Convex HTTP client). */
  refreshSession: RefreshSession;
  /** Request/response cookies for this SSR request. */
  cookies: CookieStore;
  /**
   * Seconds before access-token expiry at which {@link ServerAuthSession.getToken}
   * proactively refreshes. Defaults to 10.
   */
  refreshSkewSeconds?: number;
  /**
   * Base cookie attributes (httpOnly/sameSite/path). Per-cookie lifetime is
   * derived from the token bundle. Defaults to {@link defaultCookieOptions}.
   */
  cookieOptions?: CookieOptions;
}

export class ServerAuthSession {
  readonly #refreshSession: RefreshSession;
  readonly #cookies: CookieStore;
  readonly #refreshSkewSeconds: number;
  readonly #cookieOptions: CookieOptions;

  constructor(config: ServerAuthSessionConfig) {
    this.#refreshSession = config.refreshSession;
    this.#cookies = config.cookies;
    this.#refreshSkewSeconds = config.refreshSkewSeconds ?? 10;
    this.#cookieOptions = config.cookieOptions ?? defaultCookieOptions();
  }

  /**
   * The access token to authenticate SSR requests with. Returns the cookie's
   * token when it is still comfortably valid; otherwise refreshes (rotating the
   * refresh token and rewriting both cookies). `null` means no usable session.
   */
  async getToken(): Promise<string | null> {
    const token = (await this.#cookies.get(AUTH_JWT_COOKIE)) ?? null;
    if (token !== null && !isTokenExpiring(token, this.#refreshSkewSeconds)) {
      return token;
    }
    const bundle = await this.refresh();
    return bundle?.accessToken ?? null;
  }

  /**
   * Force a refresh from the refresh-token cookie. On success rotates the
   * tokens and rewrites both cookies; on failure (unknown/expired token) clears
   * them. Returns the new bundle or `null`.
   */
  async refresh(): Promise<TokenBundle | null> {
    const refreshToken = (await this.#cookies.get(AUTH_REFRESH_COOKIE)) ?? null;
    if (refreshToken === null) {
      return null;
    }
    const bundle = await this.#refreshSession(refreshToken);
    if (bundle === null) {
      await this.#clear();
      return null;
    }
    await this.setTokens(bundle);
    return bundle;
  }

  /**
   * Persist a token bundle as cookies. Used after a sign-in whose bundle was
   * minted elsewhere (e.g. a client provider flow) to move the refresh token
   * into the httpOnly cookie. Both cookies live as long as the refresh token;
   * the access token is refreshed on expiry via {@link getToken}.
   */
  async setTokens(bundle: TokenBundle): Promise<void> {
    await writeAuthCookies(this.#cookies, bundle, this.#cookieOptions);
  }

  /** Whether a non-expired access token is present in cookies. */
  async isAuthenticated(): Promise<boolean> {
    const token = (await this.#cookies.get(AUTH_JWT_COOKIE)) ?? null;
    return token !== null && !isTokenExpiring(token, 0);
  }

  /** Deletes the cookies. This will be reflected in the eventual response. */
  async #clear(): Promise<void> {
    await clearAuthCookies(this.#cookies);
  }
}
