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
    /** The OAuth `redirect_uri`. */
    callbackUrl: v.string(),
    /**
     * PKCE code verifier, present only when the provider config enables PKCE.
     * Stored raw because it must be sent to the provider at code exchange.
     */
    codeVerifier: v.optional(v.string()),
    /** The provider's token endpoint URL. */
    tokenEndpoint: v.string(),
    /**
     * Profile endpoints URLs to fetch with the access token after
     * the exchange, keyed by the name the app's `profile` mapping receives
     * each response under.
     */
    userInfoEndpoints: v.optional(v.record(v.string(), v.string())),
    /**
     * Expected `iss` (the OIDC issuer claim) of the provider's id_tokens,
     * copied from app-side config. Absent for non-oidc providers.
     */
    issuer: v.optional(v.string()),
    /** The callback rejects requests older than this. */
    expiresAt: v.number(),
  }).index("stateHash", ["stateHash"]),
});
