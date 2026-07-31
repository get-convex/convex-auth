/**
 * Path the component's HTTP router serves the provider callback under,
 * relative to the mount's `httpPrefix`. Also the suffix of the redirect URI
 * built from the mount-prefixed `CONVEX_SITE_URL` and registered with the
 * provider, so every use must byte-match.
 */
export const CALLBACK_PATH = "/callback";
