import { defineApp } from "convex/server";
import { v } from "convex/values";
import auth from "@convex-dev/auth/core/convex.config.js";
import apple from "@convex-dev/auth/providers/oauth/apple/convex.config.js";

const app = defineApp({
  env: {
    AUTH_PRIVATE_KEY: v.string(),
    AUTH_JWKS: v.string(),
    AUTH_APPLE_CLIENT_ID: v.string(),
    AUTH_APPLE_TEAM_ID: v.string(),
    AUTH_APPLE_KEY_ID: v.string(),
    AUTH_APPLE_PRIVATE_KEY: v.string(),
  },
});

app.use(auth, {
  httpPrefix: "/auth",
  env: {
    AUTH_PRIVATE_KEY: app.env.AUTH_PRIVATE_KEY,
    AUTH_JWKS: app.env.AUTH_JWKS,
  },
});

// The `httpPrefix` below controls where the component's `callback` route is
// mounted. That gets combined with the `CONVEX_SITE_URL` to form the full
// return URL that needs to be registered on the Services ID in your Apple
// Developer Account.
//
// The full return URL will be something like:
//
// https://happy-animal-123.convex.site/oauth/apple/callback
//
// Apple rejects localhost and IP addresses as return URLs, so this deployment
// needs a publicly reachable host like the convex.site url above. Local or
// self-hosted deployments may need to take extra steps for this, e.g., using a
// tunnel.
// The app itself can stay on localhost, since Apple never sees where the flow
// returns to.
app.use(apple, {
  httpPrefix: "/oauth/apple",
  env: {
    CLIENT_ID: app.env.AUTH_APPLE_CLIENT_ID,
    TEAM_ID: app.env.AUTH_APPLE_TEAM_ID,
    KEY_ID: app.env.AUTH_APPLE_KEY_ID,
    PRIVATE_KEY: app.env.AUTH_APPLE_PRIVATE_KEY,
  },
});

export default app;
