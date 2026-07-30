/**
 * Framework-agnostic `(Request) => Response` auth handlers.
 *
 * These are the provider-*agnostic* halves of the SSR auth surface. This
 * module exposes plain WHATWG handlers an application mounts at routes of its
 * choosing (e.g. `/auth/refresh`, `/auth/signout`). They read the httpOnly
 * refresh-token cookie from the request and reply with the access-only {@link
 * SlimTokenBundle} the browser is allowed to hold. The refresh token stays in
 * the cookie and never reaches the response body.
 *
 * Each handler takes only the one mutation reference it calls:
 * `refreshHandler` the app's `refreshSession`, `signOutHandler` its `signOut`.
 *
 * Both refuse cross-site requests up front (403, before any Convex call or
 * cookie write) by checking the `Origin` header via {@link isTrustedOrigin}.
 *
 * A provider's *sign-in* handler is the per-provider counterpart (see e.g.
 * `@convex-dev/auth/providers/anonymous/server`); it produces a
 * {@link SignInOutcome} and delegates to {@link signInResponse} to properly
 * build the response.
 *
 * @module
 */

import { ConvexHttpClient } from "convex/browser";
import type { RefreshSessionFn, SignOutFn, TokenBundle } from "../lib/types";
import { makeSlimBundle } from "../lib/types";
import {
  AUTH_REFRESH_COOKIE,
  AuthCookieOptions,
  clearAuthCookies,
  writeAuthCookies,
} from "./cookies";
import { httpCookies } from "./httpCookies";
import { forbiddenOriginResponse, isTrustedOrigin } from "./origin";
import { ServerAuthSession } from "./session";

/** A WHATWG request handler. */
export type RequestHandler = (request: Request) => Promise<Response>;

/** Configuration for {@link refreshHandler}. */
export interface RefreshHandlerConfig {
  /** The Convex deployment URL used server-side. */
  convexUrl: string;
  /** The app's `refreshSession` mutation reference. */
  refreshSession: RefreshSessionFn;
  /** Auth cookie attributes; `secure` is required. */
  cookieOptions: AuthCookieOptions;
  /** Origins beyond the request's own `Host` trusted by the CSRF origin
   * check, for deployments where the two differ (e.g. a proxy that rewrites
   * `Host`). See {@link isTrustedOrigin}. */
  allowedOrigins?: string[];
}

/**
 * A handler that rotates the session from the httpOnly refresh-token cookie and
 * rewrites both cookies, replying `{ tokens: SlimTokenBundle }`. When there is
 * no session to rotate (missing or unrecognized refresh cookie) it replies 401
 * with `{ tokens: null }`.
 */
export function refreshHandler(config: RefreshHandlerConfig): RequestHandler {
  const client = new ConvexHttpClient(config.convexUrl);
  return async (request) => {
    if (!isTrustedOrigin(request, config.allowedOrigins)) {
      return forbiddenOriginResponse();
    }
    const cookies = httpCookies(request);
    const session = new ServerAuthSession({
      refreshSession: (refreshToken) =>
        client.mutation(config.refreshSession, { refreshToken }),
      cookies,
      cookieOptions: config.cookieOptions,
    });
    const bundle = await session.refresh();
    const res =
      bundle === null
        ? Response.json({ tokens: null }, { status: 401 })
        : Response.json({ tokens: makeSlimBundle(bundle) });
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
  /** Auth cookie attributes; `secure` is required. */
  cookieOptions: AuthCookieOptions;
  /** Origins beyond the request's own `Host` trusted by the CSRF origin
   * check, for deployments where the two differ (e.g. a proxy that rewrites
   * `Host`). See {@link isTrustedOrigin}. */
  allowedOrigins?: string[];
}

/**
 * A handler that revokes the session from the httpOnly refresh-token cookie
 * (best effort) and clears both cookies, replying `{ tokens: null }`.
 */
export function signOutHandler(config: SignOutHandlerConfig): RequestHandler {
  const client = new ConvexHttpClient(config.convexUrl);
  return async (request) => {
    if (!isTrustedOrigin(request, config.allowedOrigins)) {
      return forbiddenOriginResponse();
    }
    const cookies = httpCookies(request);
    const refreshToken = (await cookies.get(AUTH_REFRESH_COOKIE)) ?? null;
    if (refreshToken !== null) {
      try {
        await client.mutation(config.signOut, { refreshToken });
      } catch {
        // Usually means we were already signed out, which is fine.
      }
    }
    await clearAuthCookies(cookies, config.cookieOptions);
    const res = Response.json({ tokens: null });
    cookies.applyTo(res.headers);
    return res;
  };
}

/**
 * What a provider's server-side sign-in produced: the minted {@link TokenBundle}
 * on success, or `tokens: null` with an optional provider-specific `userError`.
 *
 * `userError` is echoed to the browser verbatim, so it is part of the
 * provider's public contract — providers must put only detail they would
 * return from a public Convex function in it (e.g. the password provider's
 * `{ error: "INVALID_CREDENTIALS" }`), never internal diagnostics.
 */
export type SignInOutcome =
  | {
      /** The minted session tokens. */
      tokens: TokenBundle;
    }
  | {
      /** `null`: sign-in failed. */
      tokens: null;
      /** Provider-specific failure detail, echoed to the client verbatim. */
      userError?: unknown;
    };

/**
 * Build the response for a completed server-side sign-in: move the minted
 * refresh token into an httpOnly cookie (and the access token into its cookie),
 * and reply with the access-only {@link SlimTokenBundle} the browser may hold. A
 * failed outcome (`tokens: null`) writes no cookies and replies 401 with
 * `{ tokens: null }`, plus the outcome's `userError` when the provider gave one.
 *
 * Every provider's sign-in handler produces its {@link SignInOutcome}, then
 * defers to this, so the refresh token reaches only the cookie and the response
 * is uniformly shaped.
 */
export async function signInResponse(
  request: Request,
  outcome: SignInOutcome,
  cookieOptions: AuthCookieOptions,
): Promise<Response> {
  const cookies = httpCookies(request);
  // Sign-in only writes cookies — it never refreshes or revokes — so it uses the
  // cookie primitive directly rather than a `ServerAuthSession`.
  let res: Response;
  if (outcome.tokens !== null) {
    await writeAuthCookies(cookies, outcome.tokens, cookieOptions);
    res = Response.json({ tokens: makeSlimBundle(outcome.tokens) });
  } else {
    const { userError } = outcome;
    res = Response.json(
      { tokens: null, ...(userError !== undefined && { userError }) },
      { status: 401 },
    );
  }
  cookies.applyTo(res.headers);
  return res;
}
