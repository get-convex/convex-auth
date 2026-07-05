import { Infer, v } from "convex/values";

/**
 * Shared OAuth contracts used on both sides of the component boundary: the
 * oauth provider component itself and the app-side `setupOAuth` factory.
 */

/**
 * The OAuth providers the component knows how to drive. Each configured
 * provider is its own mounted instance of the component, with `PROVIDER` bound
 * to one of these names.
 */
export const vProviderName = v.union(v.literal("google"), v.literal("github"));

export type ProviderName = Infer<typeof vProviderName>;

/**
 * Why a flow was started. A `session` flow signs the user in (mints tokens); an
 * `authenticate` flow only proves account ownership (e.g. for linking) and is
 * not yet supported end-to-end — it is plumbed through storage so supporting it
 * later doesn't change any persisted shapes.
 */
export const vAuthIntent = v.union(
  v.literal("session"),
  v.literal("authenticate"),
);

export type AuthIntent = Infer<typeof vAuthIntent>;

/**
 * Error codes the HTTP callback reports to the app frontend as a
 * `?error=<code>` query param on the post-callback redirect:
 *
 *  - `access_denied` — the provider reported an error (user cancelled, etc.)
 *  - `invalid_state` — the `state` param was missing, unknown, or expired
 *  - `exchange_failed` — the code-for-token exchange or profile fetch failed
 */
export type OAuthErrorCode = "access_denied" | "invalid_state" | "exchange_failed";

const SEP = ":";

/**
 * Tag an opaque random value with the provider that minted it, e.g.
 * `"google:dxJ3…"`. Both the OAuth `state` and the one-time sign-in code use
 * this format so app-side code can route the value back to the right mounted
 * component instance without any other bookkeeping.
 */
export function withProviderPrefix(
  provider: ProviderName,
  random: string,
): string {
  return `${provider}${SEP}${random}`;
}

/**
 * Recover the provider from a value produced by {@link withProviderPrefix}.
 * Throws on anything else — callers treat that as an invalid token.
 */
export function providerFromPrefix(value: string): ProviderName {
  const prefix = value.slice(0, value.indexOf(SEP));
  if (prefix !== "google" && prefix !== "github") {
    throw new Error(`Unknown OAuth provider prefix: "${prefix}"`);
  }
  return prefix;
}
