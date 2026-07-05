import { defineSchema, defineTable } from "convex/server";
import { v } from "convex/values";
import { vAuthIntent } from "../../lib/oauth.js";
import { vAuthClaims } from "../../lib/types.js";

export default defineSchema({
  // One row per in-flight authorization: written when a flow starts, consumed
  // (single-use) when the provider redirects back. `state` is the CSRF token
  // round-tripped through the provider; the PKCE `codeVerifier` (providers
  // that use one) never leaves the server. `redirectTo` is the app path the
  // callback sends the browser back to, captured at start so the round trip
  // through the provider can't tamper with it. `challenge` binds the flow to
  // the browser that started it: the hash of a client-held verifier that must
  // be presented again at redemption. It's set on every browser-driven (HTTP)
  // flow and absent on caller-driven (`public.start`) flows, which have no
  // browser handoff to protect.
  oauthStates: defineTable({
    state: v.string(),
    codeVerifier: v.optional(v.string()),
    challenge: v.optional(v.string()),
    intent: vAuthIntent,
    redirectTo: v.string(),
    expiresAt: v.number(),
  })
    .index("by_state", ["state"])
    .index("by_expires", ["expiresAt"]),

  // Verified claims parked between the HTTP callback and the app's redeem
  // mutation, keyed by the hash of a single-use, short-lived code the browser
  // carries back to the app. Only claims are parked — no tokens exist until
  // redemption, so nothing session-granting sits at rest here. `challenge`
  // carries over from the state row; redemption must present its preimage.
  pendingSignIns: defineTable({
    codeHash: v.string(),
    challenge: v.string(),
    claims: vAuthClaims,
    intent: vAuthIntent,
    expiresAt: v.number(),
  })
    .index("by_code_hash", ["codeHash"])
    .index("by_expires", ["expiresAt"]),
});
