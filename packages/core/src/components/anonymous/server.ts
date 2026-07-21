/**
 * Server descriptor for the anonymous provider, exported at
 * `@convex-dev/auth/providers/anonymous/server`.
 *
 * It's the simplest possible provider: anonymous sign-in takes no arguments, so
 * the descriptor is just its mutation reference. Feed it to the auth server's
 * `signInHandler` to mount a route:
 *
 * ```ts
 * export const POST = auth.signInHandler(anonymous(api.auth.signInAnonymous));
 * ```
 *
 * A provider that needs input adds a `parseArgs` reading it off the request.
 *
 * @module
 */

import type { SignInProvider } from "../../server/setup";
import type { SignInAnonymousMutation } from "./react";

/** Build the anonymous {@link SignInProvider} from its sign-in mutation. */
export function anonymous(
  signIn: SignInAnonymousMutation,
): SignInProvider<Record<string, never>> {
  return { signIn };
}
