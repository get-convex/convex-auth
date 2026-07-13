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
 * Like {@link AuthClient} it takes an injected {@link AuthApi}, so it never
 * imports Convex: a framework binding supplies an `AuthApi` on top of an HTTP
 * client and a {@link CookieStore} built on its request/response cookies, and
 * tests supply fakes. The server can access the real refresh token (from the
 * cookie), so the existing `AuthApi.refreshSession(refreshToken)` shape fits
 * directly.
 *
 * @module
 */

import type { AuthApi } from "../browser/sessionManager";
import type { TokenBundle } from "../lib/types";
import {
  AUTH_JWT_COOKIE,
  AUTH_REFRESH_COOKIE,
  CookieOptions,
  CookieStore,
  defaultCookieOptions,
} from "./cookies";
import { isTokenExpiring } from "./jwt";

/** Configuration for a {@link ServerAuthSession}. */
export interface ServerAuthSessionConfig {
  /**
   * The auth API (refresh/sign-out), typically based on a Convex HTTP client.
   */
  authApi: AuthApi;
  /** Request/response cookies for this SSR request. */
  cookies: CookieStore;
  /**
   * Seconds before access-token expiry at which {@link ServerAuthSession.getToken}
   * proactively refreshes. Defaults to 10.
   */
  refreshSkewSeconds?: number;
  /**
   * Base cookie attributes (httpOnly/secure/sameSite/path). Per-cookie
   * lifetime is derived from the token bundle. Defaults to
   * {@link defaultCookieOptions}.
   */
  cookieOptions?: CookieOptions;
}

export class ServerAuthSession {
  readonly #authApi: AuthApi;
  readonly #cookies: CookieStore;
  readonly #skew: number;
  readonly #cookieOptions: CookieOptions;

  constructor(config: ServerAuthSessionConfig) {
    this.#authApi = config.authApi;
    this.#cookies = config.cookies;
    this.#skew = config.refreshSkewSeconds ?? 10;
    this.#cookieOptions = config.cookieOptions ?? defaultCookieOptions();
  }

  /**
   * The access token to authenticate SSR requests with. Returns the cookie's
   * token when it is still comfortably valid; otherwise refreshes (rotating the
   * refresh token and rewriting both cookies). `null` means no usable session.
   */
  async getToken(): Promise<string | null> {
    const token = (await this.#cookies.get(AUTH_JWT_COOKIE)) ?? null;
    if (token !== null && !isTokenExpiring(token, this.#skew)) {
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
    const bundle = await this.#authApi.refreshSession(refreshToken);
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
    const expires = new Date(bundle.refreshTokenExpiresAt);
    await this.#cookies.set(AUTH_JWT_COOKIE, bundle.accessToken, {
      ...this.#cookieOptions,
      expires,
    });
    await this.#cookies.set(AUTH_REFRESH_COOKIE, bundle.refreshToken, {
      ...this.#cookieOptions,
      expires,
    });
  }

  /**
   * Revoke the session on the server (best effort) and clear both cookies.
   * Idempotent.
   */
  async signOut(): Promise<void> {
    const refreshToken = (await this.#cookies.get(AUTH_REFRESH_COOKIE)) ?? null;
    if (refreshToken !== null) {
      try {
        await this.#authApi.signOut(refreshToken);
      } catch {
        // Usually means we were already signed out, which is fine.
      }
    }
    await this.#clear();
  }

  /** Whether a non-expired access token is present in cookies. */
  async isAuthenticated(): Promise<boolean> {
    const token = (await this.#cookies.get(AUTH_JWT_COOKIE)) ?? null;
    return token !== null && !isTokenExpiring(token, 0);
  }

  /** Deletes the cookies. This will be reflected in the eventual response. */
  async #clear(): Promise<void> {
    await this.#cookies.delete(AUTH_JWT_COOKIE);
    await this.#cookies.delete(AUTH_REFRESH_COOKIE);
  }
}
