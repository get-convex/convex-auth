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
import type { FunctionReference } from "convex/server";
import type { RefreshSessionFn, SignOutFn, TokenBundle } from "../lib/types";
import type { AuthCookieOptions } from "./cookies";
import {
  type RequestHandler,
  refreshHandler,
  signInResponse,
  signOutHandler,
} from "./handlers";

/**
 * A provider's server-side sign-in descriptor: the mutation that mints a
 * {@link TokenBundle} and, when the sign-in takes args, how to read them off the
 * request. {@link setupConvexAuthServer}'s `signInHandler` wraps it into a route.
 *
 * A `parseArgs` function that extracts args from the {@link Request} is
 * required if the mutation takes arguments.
 */
export type SignInProvider<Args extends Record<string, unknown>> = {
  /** The provider's sign-in mutation reference. */
  signIn: FunctionReference<"mutation", "public", Args, TokenBundle | null>;
} & (Args extends Record<string, never>
  ? { parseArgs?: (request: Request) => Args | Promise<Args> }
  : { parseArgs: (request: Request) => Args | Promise<Args> });

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
  const { convexUrl, cookieOptions } = config;
  const client = new ConvexHttpClient(convexUrl);
  return {
    refreshHandler: refreshHandler({
      convexUrl,
      refreshSession: config.refreshSession,
      cookieOptions,
    }),
    signOutHandler: signOutHandler({
      convexUrl,
      signOut: config.signOut,
      cookieOptions,
    }),
    /** Build a sign-in route from a provider descriptor. */
    signInHandler<Args extends Record<string, unknown>>(
      provider: SignInProvider<Args>,
    ): RequestHandler {
      // Widen the conditionally-required descriptor so parseArgs reads uniformly.
      const { signIn, parseArgs } = provider as {
        signIn: FunctionReference<
          "mutation",
          "public",
          Args,
          TokenBundle | null
        >;
        parseArgs?: (request: Request) => Args | Promise<Args>;
      };
      return async (request) => {
        const args = parseArgs ? await parseArgs(request) : ({} as Args);
        // The descriptor type-checks the args; erase the reference's arg type
        // here so the positional mutation call type-checks for any Args.
        const ref = signIn as FunctionReference<"mutation", "public">;
        const bundle: TokenBundle | null = await client.mutation(ref, args);
        return signInResponse(request, bundle, cookieOptions);
      };
    },
  };
}
