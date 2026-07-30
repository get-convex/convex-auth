/**
 * Server descriptor for the anonymous provider, exported at
 * `@convex-dev/auth/providers/anonymous/server`.
 *
 * It's the simplest possible provider: anonymous sign-in takes no arguments
 * and its mutation returns the minted bundle directly, so `run` is just the
 * mutation call. {@link anonymousRoutes} mounts it at its conventional subpath
 * via the auth server's catch-all `handler`:
 *
 * ```ts
 * setupConvexAuthServer({
 *   // ...
 *   providers: [anonymousRoutes(api.auth.signInAnonymous)],
 * });
 * ```
 *
 * Or feed the descriptor to `signInHandler` to mount a route at a custom path:
 *
 * ```ts
 * export const POST = auth.signInHandler(anonymous(api.auth.signInAnonymous));
 * ```
 *
 * A provider that needs input reads it off the request inside `run`; a
 * provider whose sign-in can fail per-user maps that failure into the
 * outcome's `userError` (see `@convex-dev/auth/providers/password/server`).
 *
 * @module
 */

import type { SignInProvider, SignInRoutes } from "../../server/setup";
import type { SignInAnonymousMutation } from "./react";
import { ANONYMOUS_SIGN_IN_PATH } from "./routes";

/** Build the anonymous {@link SignInProvider} from its sign-in mutation. */
export function anonymous(signIn: SignInAnonymousMutation): SignInProvider {
  return {
    run: async (client) => ({ tokens: await client.mutation(signIn, {}) }),
  };
}

/**
 * The anonymous sign-in route at its conventional subpath, for the `providers`
 * config of `setupConvexAuthServer`. The catch-all `handler` then serves it at
 * the path the SSR `useAnonymousAuth` hook POSTs to by default.
 */
export function anonymousRoutes(signIn: SignInAnonymousMutation): SignInRoutes {
  return { [ANONYMOUS_SIGN_IN_PATH]: anonymous(signIn) };
}
