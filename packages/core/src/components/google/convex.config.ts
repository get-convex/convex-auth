import { defineComponent } from "convex/server";
import { v } from "convex/values";

/**
 * The Google oauth component. Install it once, with the `httpPrefix` its
 * callback is served under, and bind the OAuth client's credentials:
 *
 * ```ts
 * app.use(google, {
 *   httpPrefix: "/oauth/google",
 *   env: {
 *     CLIENT_ID: app.env.AUTH_GOOGLE_CLIENT_ID,
 *     CLIENT_SECRET: app.env.AUTH_GOOGLE_CLIENT_SECRET,
 *   },
 * });
 * ```
 */
const component = defineComponent("oauthGoogle", {
  env: {
    CLIENT_ID: v.string(),
    CLIENT_SECRET: v.string(),
  },
});

export default component;
