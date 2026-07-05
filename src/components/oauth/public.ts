import { action, mutation } from "./_generated/server";
import { Infer, v } from "convex/values";
import { vAuthIntent } from "../../lib/oauth.js";
import { vAuthClaims } from "../../lib/types.js";
import { hashToken } from "../../lib/crypto.js";
import { consumePendingByHash } from "./model.js";
import { beginFlow, completeFlow } from "./flow.js";

/**
 * The component's app-facing API. The browser-driven flow (the HTTP routes in
 * http.ts) only needs `redeem`; `start` and `complete` expose the same flow
 * steps as callable functions for apps that drive the provider round-trip
 * themselves (e.g. a frontend that opens the authorization URL and receives
 * the callback on its own route).
 */

/**
 * Begin a flow, returning the provider authorization URL for the caller to
 * navigate to. The PKCE verifier (when the provider uses one) never leaves
 * the component; it's stored keyed by the returned URL's `state`.
 *
 * Unlike the HTTP `/start` route, any intent is accepted here (there's no
 * one-time-code redemption to gate): `complete` hands the intent back with
 * the claims, and the caller-driven flow enforces it at its own sign-in /
 * account-linking step.
 */
export const start = action({
  args: { intent: v.optional(vAuthIntent) },
  returns: v.object({ url: v.string() }),
  handler: async (ctx, args) => {
    return await beginFlow(ctx, {
      intent: args.intent ?? "session",
      redirectTo: "/",
    });
  },
});

const vCompleteResult = v.object({
  claims: vAuthClaims,
  intent: vAuthIntent,
});

/**
 * Complete a flow from a provider callback's `code` + `state`: validate and
 * consume the state (single-use), exchange the code, and return the verified
 * identity claims. Throws on an unknown/expired state or a failed exchange.
 */
export const complete = action({
  args: { code: v.string(), state: v.string() },
  returns: vCompleteResult,
  handler: async (ctx, args): Promise<Infer<typeof vCompleteResult>> => {
    return await completeFlow(ctx, args);
  },
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
  returns: v.union(vCompleteResult, v.null()),
  handler: async (ctx, args) => {
    return await consumePendingByHash(
      ctx,
      await hashToken(args.code),
      await hashToken(args.verifier),
    );
  },
});
