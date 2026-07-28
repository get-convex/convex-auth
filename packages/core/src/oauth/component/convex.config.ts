import { defineComponent } from "convex/server";
import { v } from "convex/values";

/**
 * The oauth component. Mounted once for all supported identity providers;
 * each provider's callback is served under `<httpPrefix>/<provider>/callback`:
 *
 * ```ts
 * app.use(oauth, {
 *   httpPrefix: "/oauth",
 *   env: {
 *     GOOGLE_CLIENT_ID: app.env.AUTH_GOOGLE_CLIENT_ID,
 *     GOOGLE_CLIENT_SECRET: app.env.AUTH_GOOGLE_CLIENT_SECRET,
 *     GITHUB_CLIENT_ID: app.env.AUTH_GITHUB_CLIENT_ID,
 *     GITHUB_CLIENT_SECRET: app.env.AUTH_GITHUB_CLIENT_SECRET,
 *   },
 * });
 * ```
 *
 * The credential bindings are what let each provider's pair reach the
 * component's callback (for the token exchange) without ever being stored in a
 * table. Every pair is optional: an app binds only the providers it uses, and a
 * `provider(...)` wired without its matching binding fails at the first sign-in
 * (see `credentials.ts`) rather than at push, since the mount bindings aren't
 * visible to the app-side setup that would otherwise catch it.
 */
const component = defineComponent("oauth", {
  env: {
    GOOGLE_CLIENT_ID: v.optional(v.string()),
    GOOGLE_CLIENT_SECRET: v.optional(v.string()),
    GITHUB_CLIENT_ID: v.optional(v.string()),
    GITHUB_CLIENT_SECRET: v.optional(v.string()),
  },
});

export default component;
