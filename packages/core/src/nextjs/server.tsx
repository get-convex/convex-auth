/**
 * Next.js (App Router) server bindings for Convex Auth, exported at
 * `@convex-dev/auth/nextjs/server`.
 *
 * Configure once with {@link setupConvexAuthNextjs} and use the returned
 * helpers across the places Next.js runs server code:
 *
 * - `convexAuthNextjsMiddleware` — refresh tokens on navigation (and optionally
 *   protect routes) from `middleware.ts`.
 * - `createConvexAuthRouteHandler` — mount at `app/api/auth/route.ts` so the
 *   client can refresh / sign out without ever seeing the refresh token.
 * - `convexAuthNextjsToken` / `isAuthenticatedNextjs` — read the access token in
 *   Server Components, route handlers, and server actions to make authenticated
 *   Convex requests (e.g. preloading content for SSR).
 * - `ConvexAuthNextjsServerProvider` — reads the current token and hands it to
 *   the client provider so the browser hydrates already authenticated.
 *
 * The refresh token lives only in an httpOnly cookie; it never reaches client
 * JS. This module builds an {@link AuthApi} over a `ConvexHttpClient` and drives
 * the framework-agnostic {@link ServerAuthSession} with cookie stores adapted
 * from `next/server` (middleware) and `next/headers` (everything else).
 *
 * @module
 */

import { ConvexHttpClient } from "convex/browser";
import { FunctionReference } from "convex/server";
import { NextRequest, NextResponse } from "next/server";
import { ReactNode } from "react";
import type { AuthApi } from "../browser/sessionManager";
import type { TokenBundle } from "../lib/types";
import { AUTH_JWT_COOKIE, CookieOptions, CookieStore } from "../server/cookies";
import { isTokenExpiring } from "../server/jwt";
import { ServerAuthSession } from "../server/session";

// `next/headers` and the client provider (`./index`) are imported dynamically,
// not at the top level, so this module can be imported from `middleware.ts`
// without pulling `next/headers` or a "use client" module into the middleware
// (edge) bundle — which Next.js rejects at build time.

/** The app's `refreshSession` + `signOut` mutation references. */
export type ConvexAuthNextjsApi = {
  refreshSession: FunctionReference<
    "mutation",
    "public",
    { refreshToken: string },
    TokenBundle | null
  >;
  signOut: FunctionReference<
    "mutation",
    "public",
    { refreshToken: string },
    null
  >;
};

/** Configuration shared by all the Next.js server helpers. */
export interface ConvexAuthNextjsConfig {
  /**
   * The Convex deployment URL used server-side (e.g. `process.env.CONVEX_URL`
   * or `process.env.NEXT_PUBLIC_CONVEX_URL`).
   */
  convexUrl: string;
  /** The app's `refreshSession` and `signOut` mutation references. */
  api: ConvexAuthNextjsApi;
  /**
   * Path the client posts to for cookie-based refresh/sign-out (the route
   * handler from {@link createConvexAuthRouteHandler}). Defaults to
   * `"/api/auth"`.
   */
  apiRoute?: string;
  /** Overrides the default auth cookie attributes. */
  cookieOptions?: CookieOptions;
}

/** Only the access-token fields — never the refresh token — sent to the client. */
export type PublicTokens = {
  accessToken: string;
  accessTokenExpiresAt: number;
  userId: string;
} | null;

function toPublicTokens(bundle: TokenBundle | null): PublicTokens {
  if (bundle === null) return null;
  return {
    accessToken: bundle.accessToken,
    accessTokenExpiresAt: bundle.accessTokenExpiresAt,
    userId: bundle.userId,
  };
}

/** Read/write/delete cookies via `next/headers` (route handlers, server actions). */
async function headersCookieStore(): Promise<CookieStore> {
  const { cookies } = await import("next/headers");
  const store = await cookies();
  return {
    get: (name) => store.get(name)?.value,
    set: (name, value, options) => {
      store.set(name, value, options as Record<string, unknown>);
    },
    delete: (name) => {
      store.delete(name);
    },
  };
}

/**
 * A {@link CookieStore} for middleware: reads from the incoming request (with
 * an overlay of anything written this pass) and records writes so they can be
 * replayed onto whichever `NextResponse` we ultimately return — including a
 * redirect, which would otherwise drop the refreshed `Set-Cookie` headers.
 */
class MiddlewareCookieStore implements CookieStore {
  #request: NextRequest;
  #overlay = new Map<string, string | null>();
  #ops: Array<
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

/** The context passed to a middleware handler for route-protection decisions. */
export interface ConvexAuthNextjsMiddlewareCtx {
  /** Whether the request carries a valid (non-expired) session. */
  isAuthenticated: () => Promise<boolean>;
  /** The current access token (refreshing if needed), or null. */
  getToken: () => Promise<string | null>;
}

export type ConvexAuthNextjsMiddlewareHandler = (
  request: NextRequest,
  ctx: ConvexAuthNextjsMiddlewareCtx,
) => NextResponse | void | Promise<NextResponse | void>;

/**
 * A redirect a middleware handler can return, resolving `path` against the
 * request's origin.
 */
export function nextjsMiddlewareRedirect(
  request: NextRequest,
  path: string,
): NextResponse {
  return NextResponse.redirect(new URL(path, request.url));
}

export function setupConvexAuthNextjs(config: ConvexAuthNextjsConfig) {
  const apiRoute = config.apiRoute ?? "/api/auth";

  const authApi: AuthApi = {
    refreshSession: (refreshToken) =>
      new ConvexHttpClient(config.convexUrl).mutation(
        config.api.refreshSession,
        {
          refreshToken,
        },
      ),
    signOut: async (refreshToken) => {
      await new ConvexHttpClient(config.convexUrl).mutation(
        config.api.signOut,
        {
          refreshToken,
        },
      );
    },
  };

  const newSession = (cookieStore: CookieStore) =>
    new ServerAuthSession({
      authApi,
      cookies: cookieStore,
      cookieOptions: config.cookieOptions,
    });

  /**
   * The Next.js middleware. Refreshes the access token when it is missing or
   * near expiry (rotating cookies), then runs the optional `handler` for route
   * protection. Any refreshed cookies are applied to the returned response,
   * including a redirect.
   */
  function convexAuthNextjsMiddleware(
    handler?: ConvexAuthNextjsMiddlewareHandler,
  ) {
    return async (request: NextRequest): Promise<NextResponse> => {
      const cookieStore = new MiddlewareCookieStore(request);
      const session = newSession(cookieStore);
      // Refresh up front so downstream Server Components see a fresh token.
      await session.getToken();

      let response: NextResponse | undefined;
      if (handler) {
        const result = await handler(request, {
          isAuthenticated: () => session.isAuthenticated(),
          getToken: () => session.getToken(),
        });
        if (result) response = result;
      }
      response = response ?? NextResponse.next();
      cookieStore.applyTo(response);
      return response;
    };
  }

  /**
   * The route handler the app mounts (e.g. `app/api/auth/route.ts`). It reads
   * the httpOnly refresh cookie and never returns the refresh token to the
   * client. Body: `{ action: "refresh" | "signOut" | "setSession", bundle? }`.
   */
  function createConvexAuthRouteHandler() {
    async function POST(request: Request): Promise<Response> {
      const body = (await request.json().catch(() => ({}))) as {
        action?: string;
        bundle?: TokenBundle | null;
      };
      const session = newSession(await headersCookieStore());
      switch (body.action) {
        case "refresh": {
          const bundle = await session.refresh();
          return Response.json({ tokens: toPublicTokens(bundle) });
        }
        case "setSession": {
          if (!body.bundle) return Response.json({ tokens: null });
          await session.setTokens(body.bundle);
          return Response.json({ tokens: toPublicTokens(body.bundle) });
        }
        case "signOut": {
          await session.signOut();
          return Response.json({ tokens: null });
        }
        default:
          return Response.json({ error: "Unknown action" }, { status: 400 });
      }
    }
    return { POST };
  }

  /**
   * The current access token from cookies, or null. Safe in Server Components:
   * it only reads (middleware is responsible for refreshing). Use it to build
   * an authenticated `ConvexHttpClient` / `preloadQuery` for SSR.
   */
  async function convexAuthNextjsToken(): Promise<string | null> {
    const store = await headersCookieStore();
    const token = (await store.get(AUTH_JWT_COOKIE)) ?? null;
    return token !== null && !isTokenExpiring(token, 0) ? token : null;
  }

  /** Whether the current request has a valid session. */
  async function isAuthenticatedNextjs(): Promise<boolean> {
    return (await convexAuthNextjsToken()) !== null;
  }

  /**
   * Server component that reads the current token and renders the client
   * provider seeded with it, so the browser hydrates already authenticated.
   * Place it in your root `app/layout.tsx`.
   */
  async function ConvexAuthNextjsServerProvider({
    children,
  }: {
    children: ReactNode;
  }) {
    const initialToken = await convexAuthNextjsToken();
    const { ConvexAuthNextjsProvider } = await import("./index");
    return (
      <ConvexAuthNextjsProvider apiRoute={apiRoute} initialToken={initialToken}>
        {children}
      </ConvexAuthNextjsProvider>
    );
  }

  return {
    convexAuthNextjsMiddleware,
    nextjsMiddlewareRedirect,
    createConvexAuthRouteHandler,
    convexAuthNextjsToken,
    isAuthenticatedNextjs,
    ConvexAuthNextjsServerProvider,
  };
}
