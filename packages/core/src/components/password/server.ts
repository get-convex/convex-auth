/**
 * Server descriptors for the password provider, exported at
 * `@convex-dev/auth/providers/password/server`.
 *
 * The password provider has two flows, so it has two descriptors: {@link
 * passwordSignIn} for signing in to an existing account and {@link
 * passwordSignUp} for creating a new one. Feed each to the auth server's
 * `signInHandler` to mount its route:
 *
 * ```ts
 * // app/auth/signin/password/route.ts
 * export const POST = auth.signInHandler(passwordSignIn(api.auth.signInWithPassword));
 * // app/auth/signup/password/route.ts
 * export const POST = auth.signInHandler(passwordSignUp(api.auth.signUpWithPassword));
 * ```
 *
 * Both flows read `{ username, password }` off the request's JSON body and run
 * the corresponding *action*. On success the outcome carries the minted
 * bundle; on failure it carries the action's `userError` (e.g.
 * `INVALID_CREDENTIALS`, `USERNAME_TAKEN`), which the handler echoes to the
 * client in its 401 reply so the UI can tell the failures apart. Those errors
 * are already the actions' public return values, so echoing them leaks nothing
 * new.
 *
 * @module
 */

import {
  InvalidSignInRequestError,
  type SignInOutcome,
  type SignInProvider,
} from "../../server/setup";
import type {
  Credentials,
  SignInWithPasswordAction,
  SignUpWithPasswordAction,
} from "./react";
import type { SignInResult, SignUpResult } from "./setup";

/**
 * Read `{ username, password }` off the request's JSON body. Throwing
 * {@link InvalidSignInRequestError} on a malformed body makes `signInHandler`
 * reply 400 — a request that isn't even credentials-shaped is the caller's
 * error, not a failed sign-in attempt.
 */
async function parseCredentials(request: Request): Promise<Credentials> {
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    throw new InvalidSignInRequestError("expected a JSON body");
  }
  const { username, password } = (body ?? {}) as Record<string, unknown>;
  if (typeof username !== "string" || typeof password !== "string") {
    throw new InvalidSignInRequestError(
      "expected a JSON body with string username and password",
    );
  }
  return { username, password };
}

/** Map a password action's result into the handler's {@link SignInOutcome}. */
function toOutcome(result: SignInResult | SignUpResult): SignInOutcome {
  return result.success
    ? { tokens: result.tokens }
    : { tokens: null, userError: result.userError };
}

/** Build the sign-in {@link SignInProvider} from the `signInWithPassword` action. */
export function passwordSignIn(
  signIn: SignInWithPasswordAction,
): SignInProvider {
  return {
    run: async (client, request) =>
      toOutcome(await client.action(signIn, await parseCredentials(request))),
  };
}

/** Build the sign-up {@link SignInProvider} from the `signUpWithPassword` action. */
export function passwordSignUp(
  signUp: SignUpWithPasswordAction,
): SignInProvider {
  return {
    run: async (client, request) =>
      toOutcome(await client.action(signUp, await parseCredentials(request))),
  };
}
