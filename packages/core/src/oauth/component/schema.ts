import { defineSchema, defineTable } from "convex/server";
import { v } from "convex/values";
import { authorizationRequestFields, ticketFields } from "../shared/schema.ts";

export default defineSchema({
  /**
   * In-flight authorization requests, created at sign-in and consumed by the
   * provider callback.
   */
  authorizationRequests: defineTable({
    ...authorizationRequestFields,
    /** Provider the request was issued for, e.g. "google". */
    providerName: v.string(),
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
     * Accepted `iss` (the OIDC issuer claim) values for the provider's
     * id_tokens, copied from app-side config. Absent for non-oidc providers.
     */
    issuers: v.optional(v.array(v.string())),
  }).index("stateHash", ["stateHash"]),

  /**
   * One-time redeemable proof that provider authentication succeeded. Minted
   * by the callback after the code exchange, redeemed exactly once by a
   * caller presenting the raw ticket code plus the original client state.
   * Nothing user-visible (accounts, users, sessions) is created until
   * redemption.
   *
   * The encrypted payload holds `{ claims, userInfoResponses }`. Which of the
   * two is present depends on what the app configured its provider with, and
   * at least one always is.
   */
  tickets: defineTable({
    ...ticketFields,
    /** Provider that authenticated the user, e.g. "google". */
    providerName: v.string(),
  }).index("ticketCodeHash", ["ticketCodeHash"]),
});
