import { defineApp } from "convex/server";
import { v } from "convex/values";
import core from "@convex-dev/auth/core/convex.config";
import passwordProvider from "@convex-dev/auth-password/component/convex.config";

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
app.use(passwordProvider);

export default app;
