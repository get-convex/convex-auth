/**
 * The framework-agnostic auth server factory, exported at
 * `@convex-dev/auth/server`.
 *
 * {@link setupConvexAuthServer} takes the shared config once (deployment URL,
 * the session mutations, and the cookie attributes) and returns the WHATWG
 * `(Request) => Response` handlers a framework mounts as routes: refresh,
 * sign-out, and a `signInHandler` that wraps any provider's {@link SignInProvider}.
 *
 * The whole surface shares one {@link AuthCookieOptions}, so `secure` is decided
 * exactly once per integration and reaches every handler, including sign-in.
 *
 * @module
 */

import { ConvexHttpClient } from "convex/browser";
import type { RefreshSessionFn, SignOutFn, TokenBundle } from "../lib/types";
import type { AuthCookieOptions } from "./cookies";
import {
  type RequestHandler,
  refreshHandler,
  signInResponse,
  signOutHandler,
} from "./handlers";
import { forbiddenOriginResponse, isTrustedOrigin } from "./origin";

/**
 * A provider's server-side sign-in descriptor: how to execute its sign-in
 * against the deployment, given the incoming {@link Request}. {@link
 * setupConvexAuthServer}'s `signInHandler` wraps it into a route.
 *
 * `run` owns the whole provider-specific half — reading any input off the
 * request and making the mutation call that mints the {@link TokenBundle}. The
 * handler stays provider-agnostic: it writes the bundle's tokens into cookies,
 * never letting the refresh token reach the response body.
 *
 * A request that isn't even shaped like the provider's input is the caller's
 * error, not a failed sign-in attempt — signal it by throwing {@link
 * InvalidSignInRequestError}, which the handler turns into a 400.
 */
export type SignInProvider = {
  /** Execute the provider's sign-in against the deployment. */
  run: (
    client: ConvexHttpClient,
    request: Request,
  ) => Promise<TokenBundle | null>;
};

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
 * });
 *
 * // in a route file:
 * export const POST = auth.signInHandler(anonymous(api.auth.signInAnonymous));
 * ```
 */
export function setupConvexAuthServer(config: ConvexAuthServerConfig) {
  const { convexUrl, cookieOptions, allowedOrigins } = config;
  const client = new ConvexHttpClient(convexUrl);
  return {
    refreshHandler: refreshHandler({
      convexUrl,
      refreshSession: config.refreshSession,
      cookieOptions,
      allowedOrigins,
    }),
    signOutHandler: signOutHandler({
      convexUrl,
      signOut: config.signOut,
      cookieOptions,
      allowedOrigins,
    }),
    /** Build a sign-in route from a provider descriptor. */
    signInHandler(provider: SignInProvider): RequestHandler {
      return async (request) => {
        // The CSRF guard, before the provider even reads the request: a
        // cross-site sign-in would store the minted session in the victim's
        // browser (login CSRF), so it must be refused up front.
        if (!isTrustedOrigin(request, allowedOrigins)) {
          return forbiddenOriginResponse();
        }
        let bundle: TokenBundle | null;
        try {
          bundle = await provider.run(client, request);
        } catch (error) {
          if (!isInvalidSignInRequestError(error)) throw error;
          return Response.json({ tokens: null }, { status: 400 });
        }
        return signInResponse(request, bundle, cookieOptions);
      };
    },
  };
}
