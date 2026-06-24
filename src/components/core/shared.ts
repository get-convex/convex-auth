import type { FunctionReference } from "convex/server";
import type { TokenBundle } from "../../lib/tokens.js";

/**
 * The runtime-agnostic kernel of the core client: no React, no DOM, no Node. It
 * owns the access-token freshness/refresh math, the refresh deduper, and the
 * core function-reference types. Keeping these here (rather than inside the
 * React client) means the refresh decision is a single, storage-agnostic
 * function: it never reads or writes any store, so the same logic can back any
 * way the core is consumed without the freshness rules drifting between them.
 *
 * Only the core's own functions belong here. Provider sign-in types belong to
 * the providers, so the core stays provider-neutral.
 */

export type { TokenBundle };

// --- Freshness --------------------------------------------------------------

/**
 * Refresh slightly before expiry so requests don't race the clock. This must
 * stay comfortably shorter than the configured access-token TTL (see
 * `setupCore`); otherwise a freshly minted token would already read as expired
 * and every request would force a refresh.
 */
export const REFRESH_SKEW_MS = 10_000;

/** True if the access token is expired (or within the skew window). */
export function isAccessTokenExpired(
  bundle: TokenBundle,
  now: number = Date.now(),
): boolean {
  return now > bundle.accessTokenExpiresAt - REFRESH_SKEW_MS;
}

// --- Refresh ----------------------------------------------------------------

/**
 * Rotates a session via the core's `refresh` mutation. A `null` result is the
 * server's signal that the session is dead (an unknown or expired refresh
 * token); the server returns it rather than throwing, so a thrown error here is
 * a genuine transport/network failure.
 */
export type RefreshFn = (refreshToken: string) => Promise<TokenBundle | null>;

/**
 * Ensure a session's access token is fresh, refreshing (and rotating the
 * refresh token) only when needed. Returns the bundle to persist — the same one
 * on the fast path, the rotated one after a refresh, or `null` when the session
 * is over. Deliberately *pure with respect to storage*: it never reads or writes
 * localStorage, cookies, or any store, leaving persistence to the caller.
 *
 * An expired (or otherwise non-fast-path) token is always sent to the server,
 * even when it looks dead locally: the server reaps an expired session as it
 * rejects the token, so presenting it is what cleans the dead row up. A `null`
 * result is the server saying the session is over, so the caller should clear
 * it. A thrown error is a transport failure (the `refresh` implementation is
 * expected to have already retried it) and propagates here *without* clearing —
 * the session may still be valid, so the caller keeps it for a later attempt
 * rather than signing the user out on a transient failure.
 */
export async function ensureFreshAccessToken(opts: {
  bundle: TokenBundle;
  refresh: RefreshFn;
  force?: boolean;
}): Promise<TokenBundle | null> {
  const { bundle, refresh, force = false } = opts;

  // Fast path: the access token is still good. Returns the same bundle
  // reference, so a caller comparing references knows nothing changed.
  if (!force && !isAccessTokenExpired(bundle)) return bundle;

  // `null` means the session is dead (and reaped); a thrown error propagates.
  return await refresh(bundle.refreshToken);
}

/**
 * Coalesce concurrent refreshes so a single rotation isn't fired twice. Returns
 * a wrapper bound to ONE instance, never a module global on a server (that
 * would coalesce across different users' requests). In the browser, one per tab
 * is correct, since module scope is per-tab.
 */
export function createRefreshDeduper<T = TokenBundle | null>(): (
  run: () => Promise<T>,
) => Promise<T> {
  let inflight: Promise<T> | null = null;
  return (run) => {
    if (!inflight) {
      inflight = run().finally(() => {
        inflight = null;
      });
    }
    return inflight;
  };
}

// --- Core function references -----------------------------------------------
//
// The app owns the export names in `convex/auth.ts`, so the core's function
// references are injected rather than imported. Typing them gives a compile
// error if those exports drift.

export type RefreshMutation = FunctionReference<
  "mutation",
  "public",
  { refreshToken: string },
  TokenBundle | null
>;

export type SignOutMutation = FunctionReference<
  "mutation",
  "public",
  { refreshToken: string },
  null
>;
