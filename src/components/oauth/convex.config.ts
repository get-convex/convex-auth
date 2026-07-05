import { defineComponent } from "convex/server";
import { v } from "convex/values";
import { vProviderName } from "../../lib/oauth.js";

/**
 * The OAuth provider component.
 *
 * One instance drives one provider: the app mounts the component once per
 * provider it offers, binding `PROVIDER` and that provider's client
 * credentials to the mount. Mounting with an `httpPrefix` (e.g.
 * `/auth/google`) exposes the component's `/start` and `/callback` routes on
 * the deployment's `.convex.site` domain, which is how the browser drives the
 * flow:
 *
 * ```ts
 * app.use(oauth, {
 *   name: "googleOAuth",
 *   httpPrefix: "/auth/google",
 *   env: {
 *     PROVIDER: "google",
 *     OAUTH_CLIENT_ID: app.env.GOOGLE_CLIENT_ID,
 *     OAUTH_CLIENT_SECRET: app.env.GOOGLE_CLIENT_SECRET,
 *     SITE_URL: app.env.SITE_URL,
 *   },
 * });
 * ```
 *
 * The redirect URI registered with the provider is stable per deployment:
 * `https://<deployment>.convex.site<httpPrefix>/callback`. It is derived from
 * `CONVEX_SITE_URL` (which Convex rewrites inside an http-prefixed component
 * to include the prefix); `OAUTH_REDIRECT_URI` overrides it for setups that
 * front the deployment with a custom domain or proxy.
 *
 * `SITE_URL` is the app frontend's origin — where the callback sends the
 * browser once the flow finishes. It is treated strictly as an origin: any
 * path on the configured URL is ignored when redirect targets are built.
 */
const component = defineComponent("oauth", {
  env: {
    PROVIDER: vProviderName,
    OAUTH_CLIENT_ID: v.string(),
    OAUTH_CLIENT_SECRET: v.string(),
    SITE_URL: v.string(),
    OAUTH_REDIRECT_URI: v.optional(v.string()),
  },
});

export default component;
