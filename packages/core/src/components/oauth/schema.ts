import { defineSchema, defineTable } from "convex/server";
import { v } from "convex/values";

export default defineSchema({
  accounts: defineTable({
    providerAccountId: v.string(),
  }),

  /**
   * In-flight authorization requests, created at sign-in and consumed by the
   * provider callback. The callback claims a request by atomically deleting
   * it (enforcing single use) and carries its fields through the code
   * exchange in memory.
   */
  authorizationRequests: defineTable({
    /** Provider the request was issued for, e.g. "google". */
    provider: v.string(),
    /** Hash of the client-generated state. The raw value is never stored. */
    stateHash: v.string(),
    /** Post-login destination, validated against allowed redirects at sign-in. */
    redirectTo: v.string(),
    /**
     * PKCE code verifier, present only when the provider config enables PKCE.
     * Stored raw because it must be sent to the provider at code exchange.
     */
    codeVerifier: v.optional(v.string()),
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
     * sha256 of the server-minted one-time token. The raw value travels only
     * in the callback redirect.
     */
    ottHash: v.string(),
    /** Tickets expire quickly (~2 minutes). */
    expiresAt: v.number(),
    /** Provider account id, e.g. the id_token `sub` claim. */
    providerAccountId: v.string(),
    /** Provider claims passed through to `completeSignIn` at redemption. */
    profile: v.any(),
  }).index("ottHash", ["ottHash"]),
});
