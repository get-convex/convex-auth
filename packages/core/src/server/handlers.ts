/**
 * Framework-agnostic `(Request) => Response` auth handlers.
 *
 * These are the provider-*agnostic* halves of the SSR auth surface — refreshing
 * the access token and signing out — as plain WHATWG handlers a framework mounts
 * at routes of its choosing (e.g. `/auth/refresh`, `/auth/signout`). They read
 * the httpOnly refresh-token cookie from the request and reply with the
 * access-only {@link SlimTokenBundle} the browser is allowed to hold — the
 * refresh token stays in the cookie and never reaches the response body.
 *
 * Each handler takes only the one mutation reference it calls: `refreshHandler`
 * the app's `refreshSession`, `signOutHandler` its `signOut`.
 *
 * A provider's *sign-in* handler is the per-provider counterpart (see e.g.
 * `@convex-dev/auth/providers/anonymous/server`); it mints a bundle and defers
 * to {@link signInResponse} to cookie it and reply.
 *
 * @module
 */

import { ConvexHttpClient } from "convex/browser";
import type { RefreshSessionFn, SignOutFn, TokenBundle } from "../lib/types";
import { makeSlimBundle } from "../lib/types";
import {
  AUTH_REFRESH_COOKIE,
  CookieOptions,
  clearAuthCookies,
  writeAuthCookies,
} from "./cookies";
import { httpCookies } from "./httpCookies";
import { ServerAuthSession } from "./session";

/** A WHATWG request handler. */
export type RequestHandler = (request: Request) => Promise<Response>;

/** Configuration for {@link refreshHandler}. */
export interface RefreshHandlerConfig {
  /** The Convex deployment URL used server-side. */
  convexUrl: string;
  /** The app's `refreshSession` mutation reference. */
  refreshSession: RefreshSessionFn;
  /** Overrides the default auth cookie attributes. */
  cookieOptions?: CookieOptions;
}

/**
 * A handler that rotates the session from the httpOnly refresh-token cookie and
 * rewrites both cookies, replying `{ tokens: SlimTokenBundle | null }`.
 */
export function refreshHandler(config: RefreshHandlerConfig): RequestHandler {
  const client = new ConvexHttpClient(config.convexUrl);
  return async (request) => {
    const cookies = httpCookies(request);
    const session = new ServerAuthSession({
      refreshSession: (refreshToken) =>
        client.mutation(config.refreshSession, { refreshToken }),
      cookies,
      cookieOptions: config.cookieOptions,
    });
    const bundle = await session.refresh();
    const res = Response.json({
      tokens: bundle === null ? null : makeSlimBundle(bundle),
    });
    cookies.applyTo(res.headers);
    return res;
  };
}

/** Configuration for {@link signOutHandler}. */
export interface SignOutHandlerConfig {
  /** The Convex deployment URL used server-side. */
  convexUrl: string;
  /** The app's `signOut` mutation reference. */
  signOut: SignOutFn;
  /** Overrides the default auth cookie attributes. */
  cookieOptions?: CookieOptions;
}

/**
 * A handler that revokes the session from the httpOnly refresh-token cookie
 * (best effort) and clears both cookies, replying `{ tokens: null }`.
 */
export function signOutHandler(config: SignOutHandlerConfig): RequestHandler {
  const client = new ConvexHttpClient(config.convexUrl);
  return async (request) => {
    const cookies = httpCookies(request);
    const refreshToken = (await cookies.get(AUTH_REFRESH_COOKIE)) ?? null;
    if (refreshToken !== null) {
      try {
        await client.mutation(config.signOut, { refreshToken });
      } catch {
        // Usually means we were already signed out, which is fine.
      }
    }
    await clearAuthCookies(cookies);
    const res = Response.json({ tokens: null });
    cookies.applyTo(res.headers);
    return res;
  };
}

/**
 * Build the response for a completed server-side sign-in: move the minted
 * refresh token into an httpOnly cookie (and the access token into its cookie),
 * and reply with the access-only {@link SlimTokenBundle} the browser may hold. A
 * `null` bundle (sign-in failed) writes no cookies and replies `{ tokens: null }`.
 *
 * Every provider's sign-in handler mints its bundle, then defers to this, so the
 * refresh token reaches only the cookie and the response is uniformly shaped.
 */
export async function signInResponse(
  request: Request,
  bundle: TokenBundle | null,
  cookieOptions?: CookieOptions,
): Promise<Response> {
  const cookies = httpCookies(request);
  // Sign-in only writes cookies — it never refreshes or revokes — so it uses the
  // cookie primitive directly rather than a `ServerAuthSession`.
  if (bundle !== null) await writeAuthCookies(cookies, bundle, cookieOptions);
  const res = Response.json({
    tokens: bundle === null ? null : makeSlimBundle(bundle),
  });
  cookies.applyTo(res.headers);
  return res;
}
