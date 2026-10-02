import type {
  FunctionArgs,
  FunctionReference,
  FunctionReturnType,
} from "convex/server";

/**
 * How a provider's sign-in functions get executed. Provider code takes this
 * as given instead of picking a transport itself. Executing the call is the
 * only thing that differs between the two session models, so one
 * implementation of a provider serves both:
 *
 *  - SPA: called against the deployment, returning the full `TokenBundle`
 *    for client JS to persist.
 *  - SSR: called through the auth proxy on the SSR host, returning an
 *    access-only `SlimTokenBundle` (the refresh token stays server-side).
 *
 * A provider never sees which model it is running under. The Convex imports
 * are type-only, which keeps provider logic free of any particular Convex
 * client class.
 *
 * Sign-in functions are safe to run before authentication on any transport.
 * Callers retry them on network errors, so a sign-in function must tolerate
 * re-executing after an attempt that already committed server-side.
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
