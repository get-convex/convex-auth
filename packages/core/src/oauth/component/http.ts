import { GenericActionCtx, GenericDataModel, httpRouter } from "convex/server";
import { env, httpAction } from "./_generated/server.ts";
import { internal } from "./_generated/api.ts";
import { CALLBACK_PATH } from "../shared/constants.ts";
import { runCallback, type ClaimedRequest } from "../shared/callback.ts";

const http = httpRouter();

/** What this component's claimed authorization request has, past the basics. */
type CustomProviderRequest = ClaimedRequest & {
  providerName: string;
  codeVerifier?: string;
  tokenEndpoint: string;
  userInfoEndpoints?: Record<string, string>;
  issuers?: string[];
};

/**
 * Handle the provider callback. Providers served by this component redirect
 * the browser back with a GET, so the parameters are in the query string, and
 * the redirect on to the app is a 302.
 */
async function handleCallback(
  ctx: GenericActionCtx<GenericDataModel>,
  request: Request,
): Promise<Response> {
  const url = new URL(request.url);
  return await runCallback<CustomProviderRequest>({
    path: url.pathname,
    params: {
      state: url.searchParams.get("state"),
      code: url.searchParams.get("code"),
      error: url.searchParams.get("error"),
      errorDescription: url.searchParams.get("error_description"),
    },
    claim: (stateHash) =>
      ctx.runMutation(internal.provider.claimAuthorizationRequest, {
        stateHash,
      }),
    mintTicket: (authRequest, ticket) =>
      ctx.runMutation(internal.provider.createTicket, {
        providerName: authRequest.providerName,
        stateHash: authRequest.stateHash,
        ...ticket,
      }),
    // This component serves whichever providers its app configured, so it
    // cannot know any provider's endpoints itself. They come off the request
    // the app's catalog filled in at sign-in. Only the credentials are known
    // here, because they are bound to this component instance.
    exchangeConfig: (authRequest) => ({
      providerName: authRequest.providerName,
      tokenEndpoint: authRequest.tokenEndpoint,
      clientId: env.CLIENT_ID,
      clientSecret: () => env.CLIENT_SECRET,
      codeVerifier: authRequest.codeVerifier,
      issuers: authRequest.issuers,
      userInfoEndpoints: authRequest.userInfoEndpoints,
    }),
    redirectStatus: 302,
  });
}

http.route({
  path: CALLBACK_PATH,
  method: "GET",
  handler: httpAction(handleCallback),
});

export default http;
