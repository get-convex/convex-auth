import { defineSchema, defineTable } from "convex/server";
import { v } from "convex/values";

export default defineSchema({
  /**
   * In-flight authorization requests, created at sign-in and consumed by the
   * provider callback.
   */
  authorizationRequests: defineTable({
    /** Provider the request was issued for, e.g. "google". */
    providerName: v.string(),
    /** Hash of the server-minted state. The raw value is never stored. */
    stateHash: v.string(),
    /** Post-login destination, validated against allowed redirects at sign-in. */
    redirectTo: v.string(),
    /**
     * The OAuth `redirect_uri`, built app-side at sign-in from
     * `CONVEX_SITE_URL` plus the mount's `httpPrefix` (the component can't
     * see system env vars). Stored so the code exchange presents the
     * byte-identical value, as OAuth requires.
     */
    callbackUrl: v.string(),
    /**
     * PKCE code verifier, present only when the provider config enables PKCE.
     * Stored raw because it must be sent to the provider at code exchange.
     */
    codeVerifier: v.optional(v.string()),
    /**
     * The provider's token endpoint (a full URL), copied from app-side
     * config at sign-in: the callback runs inside the component, which
     * can't see app config, so non-secret exchange config is stored on the
     * row.
     */
    tokenEndpoint: v.string(),
    /**
     * Profile endpoints (full URLs) to fetch with the access token after
     * the exchange, keyed by the name the app's `profile` mapping receives
     * each response under. Copied from app-side config like `tokenEndpoint`.
     */
    userInfoEndpoints: v.optional(v.record(v.string(), v.string())),
    /**
     * Expected `iss` (the OIDC issuer claim) of the provider's id_tokens,
     * copied from app-side config. Absent only for plain-OAuth providers;
     * the callback rejects any returned id_token unless this is present
     * and matches.
     */
    issuer: v.optional(v.string()),
    /** The callback rejects requests older than this. */
    expiresAt: v.number(),
  }).index("stateHash", ["stateHash"]),
});
