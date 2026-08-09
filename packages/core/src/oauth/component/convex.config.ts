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
 *
 * The mount's `httpPrefix` is the single source of truth for the callback
 * URL: inside the instance, `CONVEX_SITE_URL` comes prefixed with it, and
 * the component builds its OAuth `redirect_uri` from that.
 * `<site-url><httpPrefix>/callback` should be registered as redirect uri with
 * the identity provider.
 *
 * Each mount needs a distinct `httpPrefix`: HTTP mounts are keyed by prefix,
 * so two instances sharing one silently leaves only the last mount's
 * callback reachable.
 */
const component = defineComponent("oauth", {
  env: {
    CLIENT_ID: v.string(),
    CLIENT_SECRET: v.string(),
  },
});

export default component;
