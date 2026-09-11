import { GenericActionCtx, GenericDataModel, httpRouter } from "convex/server";
import { env, httpAction } from "./_generated/server.ts";
import { internal } from "./_generated/api.ts";
import { CALLBACK_PATH } from "../shared/constants.ts";
import { runCallback, type ClaimedRequest } from "../shared/callback.ts";
import {
  ISSUER,
  PROVIDER_NAME,
  TOKEN_ENDPOINT,
  USER_CANCELLED_ERROR,
} from "./constants.ts";
import { mintClientSecret } from "./secret.ts";
import { sanitizeAppleUser } from "./user.ts";

const http = httpRouter();

/**
 * Handle Apple's callback.
 *
 * Asking for the name or email scope makes Apple answer with a cross-site
 * POST (`response_mode=form_post`) rather than a redirect, so the parameters
 * are form fields, and every redirect on to the app is a 303 to turn the
 * browser's POST back into a GET.
 */
async function handleCallback(
  ctx: GenericActionCtx<GenericDataModel>,
  request: Request,
): Promise<Response> {
  const url = new URL(request.url);
  const form = new URLSearchParams(await request.text());
  // The name is browser-relayed, so it is sanitized before it can reach the
  // ticket payload. Apple sends it on a first authorization only.
  const user = sanitizeAppleUser(form.get("user"));
  return await runCallback<ClaimedRequest>({
    path: url.pathname,
    params: {
      state: form.get("state"),
      code: form.get("code"),
      error: form.get("error"),
      // Apple documents no error_description.
      errorDescription: null,
    },
    claim: (stateHash) =>
      ctx.runMutation(internal.provider.claimAuthorizationRequest, {
        stateHash,
      }),
    mintTicket: (authRequest, ticket) =>
      ctx.runMutation(internal.provider.createTicket, {
        stateHash: authRequest.stateHash,
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
    callbackParams: user === undefined ? undefined : { user },
    extraDeniedErrorCodes: [USER_CANCELLED_ERROR],
    redirectStatus: 303,
  });
}

http.route({
  path: CALLBACK_PATH,
  method: "POST",
  handler: httpAction(handleCallback),
});

export default http;
