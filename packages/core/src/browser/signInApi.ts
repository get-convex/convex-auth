import type {
  FunctionArgs,
  FunctionReference,
  FunctionReturnType,
} from "convex/server";
import type { HttpClientLogger } from "./createAuthClient.ts";

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

/** The deployment URL of a Convex client, or undefined when it has none. */
export function deploymentUrlOf(convex: object): string | undefined {
  return "url" in convex && typeof convex.url === "string"
    ? convex.url
    : undefined;
}

/** The logger of a Convex client, or undefined when it has none. */
export function loggerOf(convex: object): HttpClientLogger {
  if (
    "logger" in convex &&
    typeof convex.logger === "object" &&
    convex.logger !== null &&
    "log" in convex.logger &&
    typeof convex.logger.log === "function"
  ) {
    // A Convex client's logger has the other methods that the check skips.
    return convex.logger as HttpClientLogger;
  }
  return undefined;
}

/** Whether two deployment URLs match, ignoring trailing slashes. */
export function sameDeployment(a: string, b: string): boolean {
  return a.replace(/\/+$/, "") === b.replace(/\/+$/, "");
}
