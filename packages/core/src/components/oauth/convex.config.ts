import { defineComponent } from "convex/server";
import { v } from "convex/values";

/**
 * The oauth provider component. Mounted once per upstream IdP, each mount
 * with its own name, `httpPrefix` (the provider callback route), and
 * client credential bindings:
 *
 * ```ts
 * app.use(oauthProvider, {
 *   name: "oauthGoogle",
 *   httpPrefix: "/oauth/google",
 *   env: {
 *     CLIENT_ID: app.env.AUTH_GOOGLE_CLIENT_ID,
 *     CLIENT_SECRET: app.env.AUTH_GOOGLE_CLIENT_SECRET,
 *   },
 * });
 * ```
 *
 * Per-mount env bindings are what let the credential pair reach the
 * component's callback (for the token exchange) without ever being stored
 * in a table.
 */
const component = defineComponent("authOauth", {
  env: {
    CLIENT_ID: v.string(),
    CLIENT_SECRET: v.string(),
  },
});

export default component;
