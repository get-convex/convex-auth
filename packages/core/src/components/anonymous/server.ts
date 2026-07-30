/**
 * Server descriptor for the anonymous provider, exported at
 * `@convex-dev/auth/providers/anonymous/server`.
 *
 * It's the simplest possible provider: anonymous sign-in takes no arguments,
 * so `run` is just the mutation call. Feed it to the auth server's
 * `signInHandler` to mount a route:
 *
 * ```ts
 * export const POST = auth.signInHandler(anonymous(api.auth.signInAnonymous));
 * ```
 *
 * A provider that needs input reads it off the request inside `run`.
 *
 * @module
 */

import type { SignInProvider } from "../../server/setup";
import type { SignInAnonymousMutation } from "./react";

/** Build the anonymous {@link SignInProvider} from its sign-in mutation. */
export function anonymous(signIn: SignInAnonymousMutation): SignInProvider {
  return {
    run: async (client) => await client.mutation(signIn, {}),
  };
}
