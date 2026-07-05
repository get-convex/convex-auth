import { defineApp } from "convex/server";
import { v } from "convex/values";
import core from "@convex-dev/auth/core/convex.config.js";
import oauth from "@convex-dev/auth/oauth/convex.config.js";

const app = defineApp({
  env: {
    AUTH_PRIVATE_KEY: v.string(),
    AUTH_JWKS: v.string(),
    // The app frontend's origin (e.g. http://localhost:5173 in dev). OAuth
    // callbacks send the browser back here.
    SITE_URL: v.string(),
    GOOGLE_CLIENT_ID: v.string(),
    GOOGLE_CLIENT_SECRET: v.string(),
    GITHUB_CLIENT_ID: v.string(),
    GITHUB_CLIENT_SECRET: v.string(),
  },
});

app.use(core, {
  httpPrefix: "/auth",
  env: {
    AUTH_PRIVATE_KEY: app.env.AUTH_PRIVATE_KEY,
    AUTH_JWKS: app.env.AUTH_JWKS,
  },
});

// The oauth component mounts once per provider. Each mount owns its HTTP
// prefix on the deployment's .convex.site domain, so the redirect URI to
// register with the provider is stable per deployment:
// https://<deployment>.convex.site/auth/<provider>/callback
app.use(oauth, {
  name: "googleOAuth",
  httpPrefix: "/auth/google",
  env: {
    PROVIDER: "google",
    OAUTH_CLIENT_ID: app.env.GOOGLE_CLIENT_ID,
    OAUTH_CLIENT_SECRET: app.env.GOOGLE_CLIENT_SECRET,
    SITE_URL: app.env.SITE_URL,
  },
});

app.use(oauth, {
  name: "githubOAuth",
  httpPrefix: "/auth/github",
  env: {
    PROVIDER: "github",
    OAUTH_CLIENT_ID: app.env.GITHUB_CLIENT_ID,
    OAUTH_CLIENT_SECRET: app.env.GITHUB_CLIENT_SECRET,
    SITE_URL: app.env.SITE_URL,
  },
});

export default app;
