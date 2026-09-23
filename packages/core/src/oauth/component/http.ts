/**
 * The custom-provider callback.
 *
 * @module
 */
import type { HttpRouter } from "convex/server";
import { internal } from "./_generated/api.ts";
import { env } from "./_generated/server.ts";
import type { ClaimedRequest } from "../shared/callback.ts";
import { buildCallbackRouter } from "../shared/http.ts";

/** What this component's claimed authorization request has, past the basics. */
type CustomProviderRequest = ClaimedRequest & {
  providerName: string;
  tokenEndpoint: string;
  userInfoEndpoints?: Record<string, string>;
  issuers?: string[];
};

const http: HttpRouter = buildCallbackRouter<CustomProviderRequest>({
  methods: ["GET", "POST"],
  claim: (ctx, stateHash) =>
    ctx.runMutation(internal.provider.claimAuthorizationRequest, { stateHash }),
  mintTicket: (ctx, request, ticket) =>
    ctx.runMutation(internal.provider.createTicket, {
      providerName: request.providerName,
      stateHash: request.stateHash,
      ...ticket,
    }),
  // The endpoints come from the app's catalog, which saved them on the request.
  exchangeConfig: (request) => ({
    providerName: request.providerName,
    tokenEndpoint: request.tokenEndpoint,
    clientId: env.CLIENT_ID,
    clientSecret: () => env.CLIENT_SECRET,
    issuers: request.issuers,
    userInfoEndpoints: request.userInfoEndpoints,
  }),
});

export default http;
