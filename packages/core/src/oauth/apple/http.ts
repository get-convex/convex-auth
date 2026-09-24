/**
 * Apple's callback.
 *
 * @module
 */
import type { HttpRouter } from "convex/server";
import { internal } from "./_generated/api.ts";
import { env } from "./_generated/server.ts";
import type { ClaimedRequest } from "../shared/callback.ts";
import { buildCallbackRouter } from "../shared/http.ts";
import {
  CALLBACK_METHOD,
  ISSUER,
  PROVIDER_NAME,
  TOKEN_ENDPOINT,
  USER_CANCELLED_ERROR,
} from "./constants.ts";
import { mintClientSecret } from "./secret.ts";
import { sanitizeAppleUser } from "./user.ts";

const http: HttpRouter = buildCallbackRouter<ClaimedRequest>({
  methods: [CALLBACK_METHOD],
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
    // Apple has no static secret, so one is signed per exchange.
    clientSecret: () =>
      mintClientSecret({
        privateKey: env.PRIVATE_KEY,
        teamId: env.TEAM_ID,
        keyId: env.KEY_ID,
        clientId: env.CLIENT_ID,
      }),
    issuers: [ISSUER],
  }),
  // The name is browser-relayed, so it is sanitized before it can reach the
  // ticket payload. Apple sends it on a first authorization only.
  callbackParams: (fields) => {
    const user = sanitizeAppleUser(fields.get("user"));
    return user === undefined ? undefined : { user };
  },
  extraDeniedErrorCodes: [USER_CANCELLED_ERROR],
});

export default http;
