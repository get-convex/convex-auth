import { mutation } from "./_generated/server";
import { v } from "convex/values";
import { vAuthIntent } from "../../lib/oauth.js";
import { vAuthClaims } from "../../lib/types.js";
import { hashToken } from "../../lib/crypto.js";
import { consumePendingByHash } from "./model.js";

/**
 * The component's app-facing API. The flow itself is browser-driven through
 * the HTTP routes in http.ts; the app only ever calls `redeem`, to turn the
 * one-time code the callback handed the browser into verified claims.
 */

const vRedeemResult = v.object({
  claims: vAuthClaims,
  intent: vAuthIntent,
});

/**
 * Exchange a one-time sign-in code (minted by the HTTP callback) for the
 * verified claims parked under it. `verifier` must hash to the challenge the
 * flow started with, proving this caller is the browser that began it.
 * Single-use: a second redemption — or an expired or unknown code, or a
 * mismatched verifier — returns `null`, and the code is consumed either way.
 */
export const redeem = mutation({
  args: { code: v.string(), verifier: v.string() },
  returns: v.union(vRedeemResult, v.null()),
  handler: async (ctx, args) => {
    return await consumePendingByHash(
      ctx,
      await hashToken(args.code),
      await hashToken(args.verifier),
    );
  },
});
