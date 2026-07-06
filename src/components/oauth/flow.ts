import { generateState } from "arctic";
import { internal } from "./_generated/api";
import type { ActionCtx } from "./_generated/server";
import { generateToken, hashToken } from "../../lib/crypto.js";
import { withProviderPrefix, type AuthIntent } from "../../lib/oauth.js";
import type { AuthClaims } from "../../lib/types.js";
import { beginAuthorization, provider } from "./providers.js";

/**
 * The flow steps behind the HTTP routes, kept separate from the transport (an
 * action ctx and plain values in and out) so a future caller-driven transport
 * could run the same steps against the same storage.
 */

/**
 * Begin a flow: mint the provider-prefixed `state`, build the authorization
 * URL (storing the PKCE verifier when the provider uses one), and persist the
 * flow's intent and post-callback destination under that state. `challenge`
 * (the hash of a client-held verifier) is stored alongside so redemption can
 * demand its preimage.
 */
export async function beginFlow(
  ctx: ActionCtx,
  opts: { intent: AuthIntent; redirectTo: string; challenge: string },
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
