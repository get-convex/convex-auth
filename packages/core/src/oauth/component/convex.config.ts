import { defineComponent } from "convex/server";
import { v } from "convex/values";

/**
 * The oauth component. Mounted once per identity provider, each instance
 * with its own name and `httpPrefix`; the instance's callback is served at
 * `<httpPrefix>/callback`:
 *
 * ```ts
 * app.use(oauth, {
 *   name: "oauthGoogle",
 *   httpPrefix: "/oauth/google",
 *   env: {
 *     CLIENT_ID: app.env.AUTH_GOOGLE_CLIENT_ID,
 *     CLIENT_SECRET: app.env.AUTH_GOOGLE_CLIENT_SECRET,
 *   },
 * });
 * app.use(oauth, {
 *   name: "oauthGithub",
 *   httpPrefix: "/oauth/github",
 *   env: {
 *     CLIENT_ID: app.env.AUTH_GITHUB_CLIENT_ID,
 *     CLIENT_SECRET: app.env.AUTH_GITHUB_CLIENT_SECRET,
 *   },
 * });
 * ```
 */
const component = defineComponent("oauth", {
  env: {
    CLIENT_ID: v.string(),
    CLIENT_SECRET: v.string(),
  },
});

export default component;
