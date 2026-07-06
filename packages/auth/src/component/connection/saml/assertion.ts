/**
 * `component.connection.saml.assertion.*` — bounded replay cache of SAML
 * assertion IDs already accepted (sub-resource of connection).
 *
 * `accept` is an atomic insert-or-reject gate: it catches IdP-initiated
 * responses that carry no `InResponseTo` by rejecting an assertion ID that was
 * already seen for the connection. Rows are bounded by the assertion's
 * `NotOnOrAfter` and pruned by `expiresAt`.
 *
 * @module
 */

import { v } from "convex/values";

import { mutation } from "../../functions";

/**
 * Atomically accept a SAML assertion ID for a connection. Returns `true` on
 * first sighting (the row is inserted); returns `false` if the assertion ID was
 * already recorded, signalling a replay the caller must reject.
 */
export const accept = mutation({
  args: {
    connectionId: v.id("GroupConnection"),
    assertionId: v.string(),
    expiresAt: v.number(),
  },
  returns: v.boolean(),
  handler: async (ctx, { connectionId, assertionId, expiresAt }) => {
    const existing = await ctx.db
      .query("SamlSeenAssertion")
      .withIndex("connection_id_assertion_id", (idx) =>
        idx.eq("connectionId", connectionId).eq("assertionId", assertionId),
      )
      .first();
    if (existing !== null) {
      return false;
    }
    await ctx.db.insert("SamlSeenAssertion", { connectionId, assertionId, expiresAt });
    return true;
  },
});
