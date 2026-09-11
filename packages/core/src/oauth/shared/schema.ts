/**
 * The table fields every OAuth component must have.
 *
 * The shared database code in `db.ts` reads and writes these, so a component's
 * `schema.ts` spreads them into its own two tables and adds whatever else it
 * keeps. Spreading them is also what proves the contract: the component passes
 * its generated `Doc` type to the shared claim functions, which only accept a
 * document that has these fields with these types.
 *
 * @module
 */
import { v } from "convex/values";

/** What an authorization request needs, whichever provider it is for. */
export const authorizationRequestFields = {
  /** Hash of the server-minted state. The raw value is never stored. */
  stateHash: v.string(),
  /** Post-login destination, validated against allowed redirects at sign-in. */
  redirectTo: v.string(),
  /** The OAuth `redirect_uri`. */
  callbackUrl: v.string(),
  /** The callback rejects requests older than this. */
  expiresAt: v.number(),
};

/** What a ticket needs, whichever provider minted it. */
export const ticketFields = {
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
  /** Redemption rejects tickets past this. Set at mint. */
  expiresAt: v.number(),
  /**
   * The identity the provider attested, as JSON, AES-GCM encrypted with a key
   * derived from the raw ticket code. The raw code is never stored, so
   * database access alone cannot read the payload, and provider-chosen JSON
   * keys never become Convex field names.
   *
   * Which fields the JSON has depends on how the provider attests identity,
   * so each component's `tickets` table says what its own payload holds.
   */
  encryptedPayload: v.string(),
};
