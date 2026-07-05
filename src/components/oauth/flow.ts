import { generateState } from "arctic";
import { internal } from "./_generated/api";
import type { ActionCtx } from "./_generated/server";
import { generateToken, hashToken } from "../../lib/crypto.js";
import { withProviderPrefix, type AuthIntent } from "../../lib/oauth.js";
import type { AuthClaims } from "../../lib/types.js";
import { beginAuthorization, exchangeCode, provider } from "./providers.js";

/**
 * Flow orchestration shared by the two transports: the HTTP routes (the
 * browser-driven flow) and the `public.start`/`public.complete` actions (for
 * callers that drive the flow themselves). Both run the same steps against
 * the same storage, so the transports can't drift.
 */

/**
 * Begin a flow: mint the provider-prefixed `state`, build the authorization
 * URL (storing the PKCE verifier when the provider uses one), and persist the
 * flow's intent and post-callback destination under that state. `challenge`
 * (the hash of a client-held verifier, set on browser-driven flows) is stored
 * alongside so redemption can demand its preimage.
 */
export async function beginFlow(
  ctx: ActionCtx,
  opts: { intent: AuthIntent; redirectTo: string; challenge?: string },
): Promise<{ url: string }> {
  const state = withProviderPrefix(provider(), generateState());
  const { url, codeVerifier } = beginAuthorization(state);
  await ctx.runMutation(internal.model.saveState, {
    state,
    codeVerifier,
    challenge: opts.challenge,
    intent: opts.intent,
    redirectTo: opts.redirectTo,
  });
  return { url };
}

/**
 * Complete a flow in one step: consume the state (single-use) and exchange
 * the code for verified claims. Throws on an unknown/expired state or a
 * failed exchange. The HTTP callback doesn't use this — it consumes the state
 * itself first so it still knows `redirectTo` when the exchange fails.
 */
export async function completeFlow(
  ctx: ActionCtx,
  args: { code: string; state: string },
): Promise<{ claims: AuthClaims; intent: AuthIntent }> {
  const stored = await ctx.runMutation(internal.model.consumeState, {
    state: args.state,
  });
  if (!stored) throw new Error("Invalid or expired OAuth state");
  const claims = await exchangeCode({
    code: args.code,
    codeVerifier: stored.codeVerifier,
  });
  return { claims, intent: stored.intent };
}

/**
 * Park verified claims and mint the single-use, short-lived code the callback
 * hands back to the app. Only the code's hash is persisted; the raw code
 * travels once through the browser and dies on redemption — and redeeming it
 * requires the preimage of `challenge`, so only the browser that started the
 * flow can turn the code into a session.
 */
export async function mintPendingCode(
  ctx: ActionCtx,
  flow: { claims: AuthClaims; intent: AuthIntent; challenge: string },
): Promise<string> {
  const code = withProviderPrefix(provider(), generateToken());
  await ctx.runMutation(internal.model.savePending, {
    codeHash: await hashToken(code),
    challenge: flow.challenge,
    claims: flow.claims,
    intent: flow.intent,
  });
  return code;
}
