import { defineSchema, defineTable } from "convex/server";
import { v } from "convex/values";

export default defineSchema({
  /**
   * In-flight authorization requests, created at sign-in and consumed by the
   * provider callback. The callback claims a request by atomically deleting
   * it (enforcing single use) and carries its fields through the code
   * exchange in memory.
   */
  authorizationRequests: defineTable({
    /** Provider the request was issued for, e.g. "google". */
    provider: v.string(),
    /** Hash of the server-minted state. The raw value is never stored. */
    stateHash: v.string(),
    /** Post-login destination, validated against allowed redirects at sign-in. */
    redirectTo: v.string(),
    /**
     * PKCE code verifier, present only when the provider config enables PKCE.
     * Stored raw because it must be sent to the provider at code exchange.
     */
    codeVerifier: v.optional(v.string()),
    /**
     * The provider's token endpoint, copied from app-side config at
     * sign-in: the callback runs inside the component, which can't see app
     * config, so non-secret exchange config is stored on the row.
     */
    tokenEndpoint: v.string(),
    /**
     * Profile endpoints to fetch with the access token after the exchange,
     * keyed by the name the app's `profile` mapping receives each response
     * under. Copied from app-side config like `tokenEndpoint`.
     */
    userInfoEndpoints: v.optional(v.record(v.string(), v.string())),
    /**
     * Expected `iss` of the provider's id_tokens, copied from app-side
     * config. When present the callback rejects id_tokens from any other
     * issuer.
     */
    issuer: v.optional(v.string()),
    /** The callback rejects requests older than this. */
    expiresAt: v.number(),
  }).index("stateHash", ["stateHash"]),

  /**
   * One-time redeemable proof that provider authentication succeeded. Minted
   * by the callback after the code exchange, redeemed exactly once by a
   * caller presenting the raw one-time token plus the original client state.
   * Nothing user-visible (accounts, users, sessions) is created until
   * redemption.
   */
  tickets: defineTable({
    /** Provider that authenticated the user, e.g. "google". */
    provider: v.string(),
    /**
     * Carried over from the authorization request. Redemption re-checks the
     * caller-presented state against it, binding completion to the browser
     * or server that initiated the flow.
     */
    stateHash: v.string(),
    /**
     * sha256 of the server-minted one-time token. The raw value appears only
     * in the callback redirect URL and is never stored.
     */
    ottHash: v.string(),
    /** Tickets expire quickly (~2 minutes). */
    expiresAt: v.number(),
    /**
     * The identity the provider attested: JSON of
     * `{ claims, userInfoResponses }` (id_token claims when the provider
     * returned one, userinfo responses keyed by the configured endpoint
     * names; at least one is present), AES-GCM encrypted with a key derived
     * from the raw one-time token. The raw token is never stored, so
     * database access alone cannot read the payload, and provider-chosen
     * JSON keys never become Convex field names.
     */
    payload: v.string(),
  }).index("ottHash", ["ottHash"]),
});
