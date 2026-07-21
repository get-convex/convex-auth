/**
 * Server bindings for Convex Auth on Next.js (App Router), exported at
 * `@convex-dev/auth/nextjs/server`.
 *
 * This is the thin, genuinely Next-specific layer. The auth *handlers*
 * (per-provider sign-in, plus refresh/sign-out) are framework-agnostic
 * `(Request) => Response` functions mounted directly as route handlers (see
 * `@convex-dev/auth/server` and each provider's `/server` entry). What remains
 * Next-specific is the middleware (up-front refresh + redirects), reading the
 * access token in Server Components, and the server-side provider that hydrates
 * the client.
 *
 * @module
 */

import { ConvexHttpClient } from "convex/browser";
import { cookies as nextCookies } from "next/headers";
import { NextRequest, NextResponse } from "next/server";
import { ReactNode } from "react";
import type { RefreshSessionFn } from "../lib/types";
import {
  AUTH_JWT_COOKIE,
  AuthCookieOptions,
  CookieOptions,
  CookieStore,
} from "../server/cookies";
import { isTokenExpiring } from "../server/jwt";
import { ServerAuthSession } from "../server/session";

/** Configuration for {@link setupConvexAuthNextjs}. */
export interface ConvexAuthNextjsConfig {
  /** The Convex deployment URL used server-side. */
  convexUrl: string;
  /** The app's `refreshSession` mutation reference. The middleware uses it for
   * its optimistic refresh. */
  refreshSession: RefreshSessionFn;
  /** Overrides the default auth cookie attributes. */
  cookieOptions?: CookieOptions;
}

/** Context handed to a middleware handler. */
export interface ConvexAuthNextjsMiddlewareCtx {
  /** Whether the request carries a non-expired session. */
  isAuthenticated: () => Promise<boolean>;
  /** The (possibly just-refreshed) access token, or null. */
  getToken: () => Promise<string | null>;
}

/** A middleware handler: inspect the request, optionally return a response
 * (e.g. a redirect) to short-circuit. */
export type ConvexAuthNextjsMiddlewareHandler = (
  request: NextRequest,
  ctx: ConvexAuthNextjsMiddlewareCtx,
) => Promise<NextResponse | undefined | void> | NextResponse | undefined | void;

/** Redirect helper for use inside a middleware handler. */
export function nextjsMiddlewareRedirect(
  request: NextRequest,
  path: string,
): NextResponse {
  return NextResponse.redirect(new URL(path, request.url));
}

/**
 * A {@link CookieStore} implemented on an HTTP request/response model.
 *
 * Reads come from the cookies on the request; writes are buffered and applied
 * to the response via {@link MiddlewareCookieStore.applyTo}.
 */
class MiddlewareCookieStore implements CookieStore {
  readonly #request: NextRequest;
  readonly #overlay = new Map<string, string | null>();
  readonly #ops: Array<
    | { type: "set"; name: string; value: string; options?: CookieOptions }
    | { type: "delete"; name: string }
  > = [];

  constructor(request: NextRequest) {
    this.#request = request;
  }

  get(name: string): string | undefined {
    if (this.#overlay.has(name)) return this.#overlay.get(name) ?? undefined;
    return this.#request.cookies.get(name)?.value;
  }
  set(name: string, value: string, options?: CookieOptions): void {
    this.#overlay.set(name, value);
    this.#ops.push({ type: "set", name, value, options });
  }
  delete(name: string): void {
    this.#overlay.set(name, null);
    this.#ops.push({ type: "delete", name });
  }
  applyTo(response: NextResponse): void {
    for (const op of this.#ops) {
      if (op.type === "set") {
        response.cookies.set(op.name, op.value, op.options as never);
      } else {
        response.cookies.delete(op.name);
      }
    }
  }
}

/**
 * Build the Next.js server helpers from one config.
 *
 * ```ts
 * export const {
 *   convexAuthNextjsMiddleware,
 *   nextjsMiddlewareRedirect,
 *   convexAuthNextjsToken,
 *   isAuthenticatedNextjs,
 *   ConvexAuthNextjsServerProvider,
 * } = setupConvexAuthNextjs({
 *   convexUrl: process.env.NEXT_PUBLIC_CONVEX_URL!,
 *   refreshSession: api.auth.refreshSession,
 * });
 * ```
 */
export function setupConvexAuthNextjs(config: ConvexAuthNextjsConfig) {
  const httpClient = new ConvexHttpClient(config.convexUrl);

  // Next sets NODE_ENV to "production" for `next build`/`next start` and
  // "development" for `next dev`, so cookies are HTTPS-only in production while
  // still working over http on localhost. An explicit `secure` still wins.
  const cookieOptions: AuthCookieOptions = {
    ...config.cookieOptions,
    secure:
      config.cookieOptions?.secure ?? process.env.NODE_ENV === "production",
  };

  const newSession = (cookies: CookieStore) =>
    new ServerAuthSession({
      refreshSession: (refreshToken) =>
        httpClient.mutation(config.refreshSession, { refreshToken }),
      cookies,
      cookieOptions,
    });

  /** Wrap Next.js middleware to refresh the session up front (so downstream
   * Server Components see a fresh token) and optionally run redirect logic. */
  function convexAuthNextjsMiddleware(
    handler?: ConvexAuthNextjsMiddlewareHandler,
  ) {
    return async (request: NextRequest): Promise<NextResponse> => {
      const cookies = new MiddlewareCookieStore(request);
      const session = newSession(cookies);
      await session.getToken(); // refresh if near expiry, rewriting cookies

      let response: NextResponse | undefined;
      if (handler) {
        const result = await handler(request, {
          isAuthenticated: () => session.isAuthenticated(),
          getToken: () => session.getToken(),
        });
        if (result) response = result;
      }
      response = response ?? NextResponse.next();
      cookies.applyTo(response);
      return response;
    };
  }

  /** The current access token in a Server Component, or null. Never triggers a
   * refresh (the middleware does that); returns null for an expired token. */
  async function convexAuthNextjsToken(): Promise<string | null> {
    // `cookies()` is sync on Next 14 and async on Next 15; `await` covers both.
    const token = (await nextCookies()).get(AUTH_JWT_COOKIE)?.value ?? null;
    return token !== null && !isTokenExpiring(token, 0) ? token : null;
  }

  async function isAuthenticatedNextjs(): Promise<boolean> {
    return (await convexAuthNextjsToken()) !== null;
  }

  /** Server Component that reads the cookie token and renders the client
   * provider, so the client hydrates ready to authenticate. */
  async function ConvexAuthNextjsServerProvider({
    children,
  }: {
    children: ReactNode;
  }) {
    const initialToken = await convexAuthNextjsToken();
    const { ConvexAuthNextjsProvider } = await import("./index");
    return (
      <ConvexAuthNextjsProvider
        convexUrl={config.convexUrl}
        initialToken={initialToken}
      >
        {children}
      </ConvexAuthNextjsProvider>
    );
  }

  return {
    convexAuthNextjsMiddleware,
    nextjsMiddlewareRedirect,
    convexAuthNextjsToken,
    isAuthenticatedNextjs,
    ConvexAuthNextjsServerProvider,
  };
}
