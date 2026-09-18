import { defineApp } from "convex/server";
import { v } from "convex/values";
import auth from "@convex-dev/auth/core/convex.config.js";
import passwordProvider from "@convex-dev/auth/providers/password/convex.config.js";
import authEmail from "@convex-dev/auth/providers/email-password/convex.config.js";
import resend from "@convex-dev/resend/convex.config.js";

const app = defineApp({
  env: {
    AUTH_PRIVATE_KEY: v.string(),
    AUTH_JWKS: v.string(),
  },
});

app.use(auth, {
  httpPrefix: "/auth",
  env: {
    AUTH_PRIVATE_KEY: app.env.AUTH_PRIVATE_KEY,
    AUTH_JWKS: app.env.AUTH_JWKS,
  },
});
app.use(passwordProvider);
app.use(authEmail);
app.use(resend);

export default app;
