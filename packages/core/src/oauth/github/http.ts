/**
 * GitHub's callback.
 *
 * @module
 */
import type { HttpRouter } from "convex/server";
import { internal } from "./_generated/api.ts";
import { env } from "./_generated/server.ts";
import type { ClaimedRequest } from "../shared/callback.ts";
import { buildCallbackRouter } from "../shared/http.ts";
import {
  PROVIDER_NAME,
  TOKEN_ENDPOINT,
  USER_INFO_ENDPOINTS,
} from "./constants.ts";

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
    // GitHub returns no id_token, so identity comes from these instead.
    userInfoEndpoints: USER_INFO_ENDPOINTS,
  }),
});

export default http;
