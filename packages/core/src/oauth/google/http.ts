/**
 * Google's callback.
 *
 * @module
 */
import type { HttpRouter } from "convex/server";
import { internal } from "./_generated/api.ts";
import { env } from "./_generated/server.ts";
import type { ClaimedRequest } from "../shared/callback.ts";
import { buildCallbackRouter } from "../shared/http.ts";
import { ISSUERS, PROVIDER_NAME, TOKEN_ENDPOINT } from "./constants.ts";

const http: HttpRouter = buildCallbackRouter<ClaimedRequest>({
  claim: (ctx, stateHash) =>
    ctx.runMutation(internal.provider.claimAuthorizationRequest, { stateHash }),
  mintTicket: (ctx, request, ticket) =>
    ctx.runMutation(internal.provider.createTicket, {
      stateHash: request.stateHash,
      ...ticket,
    }),
  exchangeConfig: () => ({
    providerName: PROVIDER_NAME,
    tokenEndpoint: TOKEN_ENDPOINT,
    clientId: env.CLIENT_ID,
    clientSecret: () => env.CLIENT_SECRET,
    issuers: ISSUERS,
  }),
});

export default http;
