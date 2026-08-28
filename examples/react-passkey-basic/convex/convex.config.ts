import { defineApp } from "convex/server";
import { v } from "convex/values";
import core from "@convex-dev/auth/core/convex.config.js";
import passkey from "@convex-dev/auth/providers/passkey/convex.config.js";
import username from "@convex-dev/auth/username/convex.config.js";

const app = defineApp({
  env: {
    AUTH_PRIVATE_KEY: v.string(),
    AUTH_JWKS: v.string(),
  },
});

app.use(core, {
  httpPrefix: "/auth",
  env: {
    AUTH_PRIVATE_KEY: app.env.AUTH_PRIVATE_KEY,
    AUTH_JWKS: app.env.AUTH_JWKS,
  },
});
app.use(passkey);
app.use(username);

export default app;
