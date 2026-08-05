/**
 * ASPIRATIONAL API — Convex Auth v2 evaluation fixture.
 *
 * Use case: a signed-in dashboard where sensitive operations require RECENT
 * re-authentication ("prove it's still you") without signing out or
 * replacing the session. Re-auth only refreshes the current session's
 * last-verified timestamp — same session, same tokens, no reconnect.
 *
 * The guarded operations themselves live in ./account.ts; this file holds
 * the auth surface. Function bodies are TODO stubs; each TODO is the
 * behavioral spec the real implementation must satisfy. See ../README.md
 * for acceptance criteria and examples/FLOWS.md for shared conventions.
 */
import { v } from "convex/values";
import { action, mutation, query } from "./_generated/server";
import { todo, vTokenBundle } from "./authTypes";

/**
 * Prove it's still you: verify the current user's password and mark the
 * CURRENT session as freshly verified.
 */
export const reauthWithPassword = action({
  args: { password: v.string() },
  returns: v.union(
    v.object({ ok: v.literal(true), freshUntil: v.number() }),
    v.object({ ok: v.literal(false), code: v.string(), message: v.string() }),
  ),
  handler: async (_ctx, _args) => {
    // TODO(auth-v2):
    // 1. Requires authentication — this is re-auth, not sign-in.
    // 2. Verify the CURRENT user's password: rate limited ->
    //    { ok: false, code: "RATE_LIMITED" }; wrong password ->
    //    { ok: false, code: "INVALID_CREDENTIALS" }.
    // 3. On success, update the current session's last-verified timestamp.
    //    SAME session, SAME tokens, no reconnect — nothing about the
    //    connection changes, only the session's freshness.
    // 4. Return { ok: true, freshUntil } where freshUntil = now + the
    //    policy window (5 minutes here).
    return todo("reauthWithPassword");
  },
});

/**
 * Reactive freshness of the current session, so the UI can show/hide the
 * re-auth prompt proactively (and count down as the window closes).
 */
export const authFreshness = query({
  args: {},
  returns: v.union(v.object({ freshUntil: v.number() }), v.null()),
  handler: async (_ctx) => {
    // TODO(auth-v2): return { freshUntil } for the current session — the
    // moment its last verification ages past the default policy window.
    // Being a query, this updates reactively after reauthWithPassword.
    // Return null when not authenticated. NOTE: this is advisory UX only;
    // the real guards are server-side in ./account.ts.
    return todo("authFreshness");
  },
});

// --- Standard session plumbing (matches the existing client contract) -----

export const refreshSession = mutation({
  args: { refreshToken: v.string() },
  returns: v.union(vTokenBundle, v.null()),
  handler: async (_ctx, _args) => {
    // TODO(auth-v2): rotate the refresh token (reuse detection, grace
    // window); return null for dead sessions.
    return todo("refreshSession");
  },
});

export const signOut = mutation({
  args: { refreshToken: v.string() },
  returns: v.null(),
  handler: async (_ctx, _args) => {
    // TODO(auth-v2): revoke the session; idempotent.
    return todo("signOut");
  },
});
