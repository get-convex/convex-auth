import type {
  FunctionArgs,
  FunctionReference,
  FunctionReturnType,
} from "convex/server";

/**
 * The API that runs a provider's sign-in functions. Provider code calls it
 * through `AuthClient.signIn` and does not pick a transport itself. Running
 * the call is the only part that differs between the two session models, so
 * one provider implementation serves both.
 *
 * - Under SPA it calls the deployment and returns the full `TokenBundle` for
 *   client JS to persist.
 * - Under SSR it calls the auth proxy on the SSR host and returns an
 *   access-only `SlimTokenBundle`. The refresh token stays on the server.
 *
 * A provider never sees which model it runs under.
 *
 * Sign-in functions are safe to run before authentication on any transport.
 */
export interface AuthSignInApi {
  mutation<F extends FunctionReference<"mutation", "public">>(
    fn: F,
    args: FunctionArgs<F>,
  ): Promise<FunctionReturnType<F>>;
  action<F extends FunctionReference<"action", "public">>(
    fn: F,
    args: FunctionArgs<F>,
  ): Promise<FunctionReturnType<F>>;
}
