import { httpRouter } from "convex/server";
import { httpAction, env } from "./_generated/server";

// The core serves its own JWKS. AUTH_JWKS is a static env var set by running
// `npx @convex-dev/auth` and is served verbatim here. Convex mounts these
// routes under the prefix the app declares in convex.config.ts
// (`app.use(core, { httpPrefix: "/auth" })`), so the served path is
// <prefix>/.well-known/jwks.json — point auth.config.ts's `jwks` URL there.
const http = httpRouter();

http.route({
  path: "/.well-known/jwks.json",
  method: "GET",
  handler: httpAction(async (_ctx) => {
    return new Response(env.AUTH_JWKS, {
      status: 200,
      headers: {
        "Content-Type": "application/json",
        "Cache-Control": "public, max-age=3600",
      },
    });
  }),
});

export default http;
