import { httpRouter } from "convex/server";
import { httpAction } from "./_generated/server";

// Each per-IdP mount serves its own provider callback under the prefix the
// app declares in convex.config.ts (`app.use(oauthProvider, { name:
// "oauthGoogle", httpPrefix: "/oauth/google", ... })`), so the served path
// is <prefix>/callback — the redirect URI registered with the provider.
const http = httpRouter();

http.route({
  path: "/callback",
  method: "GET",
  handler: httpAction(async () => {
    // TODO: claim the authorization request by state, exchange the code,
    // mint a one-time ticket, and redirect to the stored redirectTo.
    return new Response("Not implemented", { status: 501 });
  }),
});

export default http;
