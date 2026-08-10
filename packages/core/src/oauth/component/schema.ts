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

  /**
   * One-time redeemable proof that provider authentication succeeded. Minted
   * by the callback after the code exchange, redeemed exactly once by a
   * caller presenting the raw ticket code plus the original client state.
   * Nothing user-visible (accounts, users, sessions) is created until
   * redemption.
   */
  tickets: defineTable({
    /** Provider that authenticated the user, e.g. "google". */
    providerName: v.string(),
    /**
     * Carried over from the authorization request. Redemption re-checks the
     * caller-presented state against it, binding completion to the browser
     * or server that initiated the flow.
     */
    stateHash: v.string(),
    /**
     * sha256 of the server-minted ticket code. The raw value appears only
     * in the callback redirect URL and is never stored.
     */
    ticketCodeHash: v.string(),
    /**
     * Redemption rejects tickets past this. Set at mint from
     * `TICKET_TTL_MS` in provider.ts (2 minutes).
     */
    expiresAt: v.number(),
    /**
     * The identity the provider attested: JSON of
     * `{ claims, userInfoResponses }` (id_token claims when the provider
     * returned one, userinfo responses keyed by the configured endpoint
     * names; at least one is present), AES-GCM encrypted with a key derived
     * from the raw ticket code. The raw code is never stored, so
     * database access alone cannot read the payload, and provider-chosen
     * JSON keys never become Convex field names.
     */
    payload: v.string(),
  }).index("ticketCodeHash", ["ticketCodeHash"]),
});
