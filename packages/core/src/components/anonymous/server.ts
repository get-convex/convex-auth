/**
 * Server handler for the anonymous provider, exported at
 * `@convex-dev/auth/providers/anonymous/server`.
 *
 * It's the simplest possible provider handler — anonymous sign-in takes no
 * arguments. A provider that needs input parses it from the request body.
 *
 * @module
 */

import { ConvexHttpClient } from "convex/browser";
import type { CookieOptions } from "../../server/cookies";
import { type RequestHandler, signInResponse } from "../../server/handlers";
import type { SignInAnonymousMutation } from "./react";

/** Configuration for {@link anonymousSignInHandler}. */
export interface AnonymousSignInHandlerConfig {
  /** The Convex deployment URL used server-side. */
  convexUrl: string;
  /** The app's `signInAnonymous` mutation reference. */
  signIn: SignInAnonymousMutation;
  /** Overrides the default auth cookie attributes. */
  cookieOptions?: CookieOptions;
}

/**
 * A handler that runs the anonymous sign-in mutation server-side, moves the
 * minted refresh token into an httpOnly cookie, and replies with a bundle
 * containing only the access token (`{ tokens: SlimTokenBundle }`).
 */
export function anonymousSignInHandler(
  config: AnonymousSignInHandlerConfig,
): RequestHandler {
  return async (request) => {
    const bundle = await new ConvexHttpClient(config.convexUrl).mutation(
      config.signIn,
      {},
    );
    return signInResponse(request, bundle, config.cookieOptions);
  };
}
