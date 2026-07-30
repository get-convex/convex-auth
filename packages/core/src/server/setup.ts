/**
 * The framework-agnostic auth server factory, exported at
 * `@convex-dev/auth/server`.
 *
 * {@link setupConvexAuthServer} takes the shared config once (deployment URL,
 * the session mutations, and the cookie attributes) and returns the WHATWG
 * `(Request) => Response` handlers a framework mounts as routes: refresh,
 * sign-out, and a `signInHandler` that wraps any provider's {@link SignInProvider}.
 *
 * It also returns a single catch-all `handler` that serves all of those routes
 * from one mount point (e.g. a Next.js `app/auth/[...convexAuth]/route.ts`),
 * dispatching by pathname. Sign-in routes for it come from the `providers`
 * config, typically built with a provider's routes helper (`passwordRoutes`,
 * `anonymousRoutes`).
 *
 * The whole surface shares one {@link AuthCookieOptions}, so `secure` is decided
 * exactly once per integration and reaches every handler, including sign-in.
 *
 * @module
 */

import { ConvexHttpClient } from "convex/browser";
import { AUTH_BASE_PATH, REFRESH_PATH, SIGN_OUT_PATH } from "../lib/routes";
import type { RefreshSessionFn, SignOutFn } from "../lib/types";
import type { AuthCookieOptions } from "./cookies";
import {
  type RequestHandler,
  type SignInOutcome,
  refreshHandler,
  signInResponse,
  signOutHandler,
} from "./handlers";
import { forbiddenOriginResponse, isTrustedOrigin } from "./origin";

export type { SignInOutcome } from "./handlers";

/**
 * A provider's server-side sign-in descriptor: how to execute its sign-in
 * against the deployment, given the incoming {@link Request}. {@link
 * setupConvexAuthServer}'s `signInHandler` wraps it into a route.
 *
 * `run` owns the whole provider-specific half — reading any input off the
 * request and making the Convex call (mutation or action), mapping its result
 * into a {@link SignInOutcome}. The handler stays provider-agnostic: it writes
 * the outcome's tokens into cookies (never letting the refresh token reach the
 * response body); a failed outcome replies 401, echoing the outcome's
 * `userError`, if any, to the client.
 *
 * A request that isn't even shaped like the provider's input is the caller's
 * error, not a failed sign-in attempt — signal it by throwing {@link
 * InvalidSignInRequestError}, which the handler turns into a 400.
 */
export type SignInProvider = {
  /** Execute the provider's sign-in against the deployment. */
  run: (client: ConvexHttpClient, request: Request) => Promise<SignInOutcome>;
};

/**
 * Sign-in routes contributed by a provider: subpaths under the auth base path
 * (e.g. `"signin/password"`) mapped to the {@link SignInProvider} mounted
 * there. Built with a provider's routes helper and passed to {@link
 * setupConvexAuthServer}'s `providers` config for the catch-all `handler`.
 */
export type SignInRoutes = Record<string, SignInProvider>;

const INVALID_SIGN_IN_REQUEST_MARKER = "ConvexAuthInvalidSignInRequest";

/**
 * Thrown by a {@link SignInProvider}'s `run` when the request doesn't carry
 * the input the provider expects (e.g. a body that isn't credentials-shaped).
 * `signInHandler` replies 400 to it; any other error from `run` propagates as
 * the server failure it is.
 */
export class InvalidSignInRequestError extends Error {
  /** Marker consulted instead of `instanceof`, so detection survives
   * duplicated copies of this package in one app. */
  readonly [INVALID_SIGN_IN_REQUEST_MARKER] = true;
}

function isInvalidSignInRequestError(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    (error as Record<string, unknown>)[INVALID_SIGN_IN_REQUEST_MARKER] === true
  );
}

/** Configuration for {@link setupConvexAuthServer}. */
export interface ConvexAuthServerConfig {
  /** The Convex deployment URL used server-side. */
  convexUrl: string;
  /** The app's `refreshSession` mutation reference. */
  refreshSession: RefreshSessionFn;
  /** The app's `signOut` mutation reference. */
  signOut: SignOutFn;
  /** Auth cookie attributes for every handler; `secure` is required. */
  cookieOptions: AuthCookieOptions;
  /** Origins beyond the request's own `Host` trusted by every handler's CSRF
   * origin check, for deployments where the two differ (e.g. a proxy that
   * rewrites `Host`). See {@link isTrustedOrigin}. */
  allowedOrigins?: string[];
  /** Sign-in routes served by the catch-all `handler`, typically built with
   * each provider's routes helper (e.g. `passwordRoutes`). Not needed when
   * mounting sign-in routes individually via `signInHandler`. */
  providers?: SignInRoutes[];
  /** Path prefix the catch-all `handler` expects the auth routes to be
   * mounted under. Defaults to {@link AUTH_BASE_PATH} (`"/auth"`), matching
   * the client hooks' default routes. */
  basePath?: string;
}

/**
 * Configure the auth handlers once and get back the routes to mount.
 *
 * ```ts
 * export const auth = setupConvexAuthServer({
 *   convexUrl: process.env.NEXT_PUBLIC_CONVEX_URL!,
 *   refreshSession: api.auth.refreshSession,
 *   signOut: api.auth.signOut,
 *   cookieOptions: { secure: process.env.NODE_ENV === "production" },
 *   providers: [
 *     passwordRoutes({
 *       signIn: api.auth.signInWithPassword,
 *       signUp: api.auth.signUpWithPassword,
 *     }),
 *     anonymousRoutes(api.auth.signInAnonymous),
 *   ],
 * });
 *
 * // in a catch-all route file, e.g. app/auth/[...convexAuth]/route.ts:
 * export const POST = auth.handler;
 * ```
 *
 * Individual handlers remain available for mounting routes one by one, at
 * custom paths:
 *
 * ```ts
 * // app/auth/refresh/route.ts
 * export const POST = auth.refreshHandler;
 * // app/custom/anon/route.ts
 * export const POST = auth.signInHandler(anonymous(api.auth.signInAnonymous));
 * ```
 */
export function setupConvexAuthServer(config: ConvexAuthServerConfig) {
  const { convexUrl, cookieOptions, allowedOrigins } = config;
  const client = new ConvexHttpClient(convexUrl);

  /** Build a sign-in route from a provider descriptor. */
  function signInHandler(provider: SignInProvider): RequestHandler {
    return async (request) => {
      // The CSRF guard, before the provider even reads the request: a
      // cross-site sign-in would store the minted session in the victim's
      // browser (login CSRF), so it must be refused up front.
      if (!isTrustedOrigin(request, allowedOrigins)) {
        return forbiddenOriginResponse();
      }
      let outcome: SignInOutcome;
      try {
        outcome = await provider.run(client, request);
      } catch (error) {
        if (!isInvalidSignInRequestError(error)) throw error;
        return Response.json({ tokens: null }, { status: 400 });
      }
      return signInResponse(request, outcome, cookieOptions);
    };
  }

  // The catch-all handler's route table: the built-in session routes plus
  // every configured provider's sign-in routes, keyed by subpath.
  const routes = new Map<string, RequestHandler>([
    [
      REFRESH_PATH,
      refreshHandler({
        convexUrl,
        refreshSession: config.refreshSession,
        cookieOptions,
        allowedOrigins,
      }),
    ],
    [
      SIGN_OUT_PATH,
      signOutHandler({
        convexUrl,
        signOut: config.signOut,
        cookieOptions,
        allowedOrigins,
      }),
    ],
  ]);
  for (const providerRoutes of config.providers ?? []) {
    for (const [subpath, provider] of Object.entries(providerRoutes)) {
      if (routes.has(subpath)) {
        throw new Error(`Duplicate auth route "${subpath}"`);
      }
      routes.set(subpath, signInHandler(provider));
    }
  }

  const basePath = config.basePath ?? AUTH_BASE_PATH;
  const prefix = basePath.endsWith("/") ? basePath : `${basePath}/`;

  /**
   * The catch-all handler: serves every configured route from one mount
   * point, dispatching on the request's pathname under `basePath`. Replies
   * 404 for unknown paths and 405 for anything but POST. The failure bodies
   * carry `tokens: null` so clients can parse every reply the same way.
   */
  const handler: RequestHandler = async (request) => {
    const { pathname } = new URL(request.url);
    const route = pathname.startsWith(prefix)
      ? routes.get(pathname.slice(prefix.length))
      : undefined;
    if (route === undefined) {
      return Response.json({ tokens: null }, { status: 404 });
    }
    if (request.method !== "POST") {
      return Response.json(
        { tokens: null },
        { status: 405, headers: { allow: "POST" } },
      );
    }
    return route(request);
  };

  return {
    refreshHandler: routes.get(REFRESH_PATH)!,
    signOutHandler: routes.get(SIGN_OUT_PATH)!,
    signInHandler,
    handler,
  };
}
