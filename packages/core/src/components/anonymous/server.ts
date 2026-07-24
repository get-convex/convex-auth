/**
 * Server descriptor for the anonymous provider, exported at
 * `@convex-dev/auth/providers/anonymous/server`.
 *
 * It's the simplest possible provider: anonymous sign-in takes no arguments
 * and its mutation returns the minted bundle directly, so `run` is just the
 * mutation call. Feed it to the auth server's `signInHandler` to mount a
 * route:
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

import type { SignInProvider } from "../../server/setup";
import type { SignInAnonymousMutation } from "./react";

/** Build the anonymous {@link SignInProvider} from its sign-in mutation. */
export function anonymous(signIn: SignInAnonymousMutation): SignInProvider {
  return {
    run: async (client) => ({ tokens: await client.mutation(signIn, {}) }),
  };
}
