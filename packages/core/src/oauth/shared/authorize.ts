/**
 * The app-side start of an OAuth flow, shared by every provider.
 *
 * Every provider does the same three things here: check where the flow is
 * allowed to return to, mint the state that ties the callback back to this
 * client, and build the URL to send the browser to. What differs is the
 * endpoint and the scopes.
 *
 * @module
 */
import { mutationGeneric } from "convex/server";
import type {
  FunctionReference,
  GenericDataModel,
  GenericMutationCtx,
} from "convex/server";
import { v } from "convex/values";
import { sha256Hex } from "../../lib/crypto.ts";
import { generateRandomToken, sha256Base64Url } from "./crypto.ts";
import type { CallbackMethod } from "./http.ts";
import { parseUrl } from "./redemption.ts";

type MutationCtx = GenericMutationCtx<GenericDataModel>;

type CreateAuthorizationRequestArgs = {
  stateHash: string;
  redirectTo: string;
  codeVerifier: string;
};

type CreateAuthorizationRequestResult = {
  clientId: string;
  callbackUrl: string;
};

type CreateAuthorizationRequestRef = FunctionReference<
  "mutation",
  "internal",
  CreateAuthorizationRequestArgs,
  CreateAuthorizationRequestResult
>;

/**
 * Build a provider's `startSignIn` mutation.
 *
 * The server mints `state` and returns it; the client keeps it (it must
 * present the same value again to complete sign-in) and navigates to the
 * returned `redirect` URL.
 */
export function buildStartSignIn(options: {
  /** Origins `redirectTo` may point at, already validated and normalized. */
  allowedOrigins: string[];
  /** The provider's authorization endpoint (a full URL). */
  authorizationEndpoint: string;
  /** Scopes to request. Left off the URL entirely when empty. */
  scopes: readonly string[];
  /**
   * The method the provider delivers the callback with. `"POST"` adds
   * `response_mode=form_post` to the authorization URL.
   */
  callbackMethod?: CallbackMethod;
  /**
   * Record the request in this provider's component instance, and hand back
   * what the authorization URL needs.
   *
   * A component that records nothing beyond the three arguments takes the
   * mutation reference itself. One that records more takes a function, which
   * adds its own fields before calling the component.
   */
  createAuthorizationRequest:
    | CreateAuthorizationRequestRef
    | ((
        ctx: MutationCtx,
        args: CreateAuthorizationRequestArgs,
      ) => Promise<CreateAuthorizationRequestResult>);
}) {
  return mutationGeneric({
    args: {
      redirectTo: v.string(),
    },
    returns: v.object({ redirect: v.string(), state: v.string() }),
    handler: async (ctx, args) => {
      const redirectTo = parseUrl(args.redirectTo);
      if (redirectTo === null) {
        throw new Error("redirectTo must be an absolute URL");
      }
      if (!options.allowedOrigins.includes(redirectTo.origin)) {
        throw new Error(
          `redirectTo origin "${redirectTo.origin}" is not in allowedRedirectOrigins`,
        );
      }

      const state = generateRandomToken();
      const codeVerifier = generateRandomToken();
      const requestArgs = {
        stateHash: await sha256Hex(state),
        redirectTo: args.redirectTo,
        codeVerifier,
      };
      // A function reference is a plain object at runtime, so `typeof` is
      // what tells the two apart.
      const { clientId, callbackUrl } =
        typeof options.createAuthorizationRequest === "function"
          ? await options.createAuthorizationRequest(ctx, requestArgs)
          : await ctx.runMutation(
              options.createAuthorizationRequest,
              requestArgs,
            );

      const params: Record<string, string> = {
        response_type: "code",
        client_id: clientId,
        redirect_uri: callbackUrl,
        state,
        // Every provider gets a challenge. One that does not implement PKCE
        // ignores the parameters, which RFC 6749 requires of it.
        code_challenge: await sha256Base64Url(codeVerifier),
        code_challenge_method: "S256",
      };
      if (options.scopes.length > 0) {
        params.scope = options.scopes.join(" ");
      }
      if (options.callbackMethod === "POST") {
        params.response_mode = "form_post";
      }

      const url = new URL(options.authorizationEndpoint);
      for (const [key, value] of Object.entries(params)) {
        url.searchParams.set(key, value);
      }

      return { redirect: url.toString(), state };
    },
  });
}
