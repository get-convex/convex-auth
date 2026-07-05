import { mutationGeneric } from "convex/server";
import { ConvexError, v } from "convex/values";
import type { ComponentApi } from "./_generated/component.js";
import { providerFromPrefix, type ProviderName } from "../../lib/oauth.js";
import {
  vTokenBundle,
  type CompleteSignIn,
  type TokenBundle,
} from "../../lib/types.js";

/**
 * Build the app-facing OAuth handlers from the mounted provider component
 * instances and the core's `completeSignIn` (from `setupCore`).
 *
 * The browser-driven flow needs no app endpoints besides the returned
 * `redeemOAuthCode`: the component's own HTTP routes take the user to the
 * provider and back, then hand the browser a one-time code, and this mutation
 * exchanges that code for a session. The client binds the flow to itself by
 * minting a random verifier up front, keeping it local, and sending its
 * SHA-256 as `challenge` to `/start`; redemption demands the verifier back.
 * The full loop:
 *
 * ```
 * client  →  mint verifier, keep it; challenge = SHA-256(verifier)
 * browser →  GET <site>/auth/google/start?redirectTo=/&challenge=…  (component route)
 *         →  provider consent
 *         →  GET <site>/auth/google/callback?code&state             (component route)
 *         →  302 SITE_URL/?code=<one-time code>
 * app     →  redeemOAuthCode({ code, verifier })  →  TokenBundle
 * ```
 *
 * `redeemOAuthCode` rejects with a `ConvexError` whose `data.code` is:
 *
 *  - `"invalid_code"` — unknown, already-redeemed, or expired code, or a
 *    verifier that doesn't match the flow's challenge (also covers a
 *    provider this app hasn't configured). A mismatched verifier consumes
 *    the code, so it can't be retried with new guesses.
 *  - `"intent_not_supported"` — the flow was started with an intent other
 *    than `session` (account linking is not supported yet)
 */
export function setupOAuth(opts: {
  /**
   * The mounted component instance for each offered provider, e.g.
   * `{ google: components.googleOAuth }`.
   */
  providers: Partial<Record<ProviderName, ComponentApi>>;
  /** The core's claims-for-session exchange, as returned by `setupCore`. */
  completeSignIn: CompleteSignIn;
}) {
  const { providers, completeSignIn } = opts;

  /**
   * Exchange a one-time sign-in code (carried back into the app by the OAuth
   * callback's redirect as `?code=`) for a session. `verifier` is the
   * client-held preimage of the challenge the flow started with. Single-use;
   * see `setupOAuth` for the error contract.
   */
  const redeemOAuthCode = mutationGeneric({
    args: { code: v.string(), verifier: v.string() },
    returns: vTokenBundle,
    handler: async (ctx, args): Promise<TokenBundle> => {
      const invalidCode = () => new ConvexError({ code: "invalid_code" });

      // The code is provider-prefixed, so it routes itself to the instance
      // that minted it. Garbage input routes nowhere.
      let provider: ProviderName;
      try {
        provider = providerFromPrefix(args.code);
      } catch {
        throw invalidCode();
      }
      const component = providers[provider];
      if (!component) throw invalidCode();

      const pending = await ctx.runMutation(component.public.redeem, {
        code: args.code,
        verifier: args.verifier,
      });
      if (!pending) throw invalidCode();
      if (pending.intent !== "session") {
        throw new ConvexError({ code: "intent_not_supported" });
      }
      return await completeSignIn(ctx, pending.claims);
    },
  });

  return { redeemOAuthCode };
}
