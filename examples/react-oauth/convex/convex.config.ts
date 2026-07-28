import { defineApp } from "convex/server";
import { v } from "convex/values";
import core from "@convex-dev/auth/core/convex.config.js";
import oauth from "@convex-dev/auth/providers/oauth/convex.config.js";

const app = defineApp({
  env: {
    AUTH_PRIVATE_KEY: v.string(),
    AUTH_JWKS: v.string(),
    AUTH_GOOGLE_CLIENT_ID: v.string(),
    AUTH_GOOGLE_CLIENT_SECRET: v.string(),
    AUTH_GITHUB_CLIENT_ID: v.string(),
    AUTH_GITHUB_CLIENT_SECRET: v.string(),
  },
});

app.use(core, {
  httpPrefix: "/auth",
  env: {
    AUTH_PRIVATE_KEY: app.env.AUTH_PRIVATE_KEY,
    AUTH_JWKS: app.env.AUTH_JWKS,
  },
});

// The oauth component mounts once for all identity providers; it serves a
// callback per provider under `/oauth/<provider>/callback`. Bind each provider's
// credentials — only the ones this app uses need binding.
app.use(oauth, {
  httpPrefix: "/oauth",
  env: {
    GOOGLE_CLIENT_ID: app.env.AUTH_GOOGLE_CLIENT_ID,
    GOOGLE_CLIENT_SECRET: app.env.AUTH_GOOGLE_CLIENT_SECRET,
    GITHUB_CLIENT_ID: app.env.AUTH_GITHUB_CLIENT_ID,
    GITHUB_CLIENT_SECRET: app.env.AUTH_GITHUB_CLIENT_SECRET,
  },
});

export default app;
