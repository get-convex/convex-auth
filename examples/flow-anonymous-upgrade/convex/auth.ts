/**
 * ASPIRATIONAL API — Convex Auth v2 evaluation fixture.
 *
 * Use case: guest-first app. Visitors are signed in anonymously on first
 * load and can immediately create real data (a tiny todo list). "Create
 * account" upgrades the guest to email+password while KEEPING the same
 * userId — and therefore all of their data.
 *
 * Function bodies are TODO stubs; each TODO is the behavioral spec the real
 * implementation must satisfy. See ../README.md for acceptance criteria and
 * examples/FLOWS.md for shared conventions.
 */
import { v } from "convex/values";
import { action, mutation } from "./_generated/server";
import { todo, vFlowResult, vTokenBundle } from "./authTypes";

/**
 * Create an anonymous user and sign it in — no input from the visitor.
 *
 * A mutation (not an action): no hashing, no email, just document writes.
 */
export const signInAnonymously = mutation({
  args: {},
  returns: vFlowResult,
  handler: async (_ctx, _args) => {
    // TODO(auth-v2):
    // 1. Rate limit per caller -> { status: "error", code: "RATE_LIMITED" }
    //    (anonymous sign-in is a cheap way to mass-create users otherwise).
    // 2. Invoke the app's user-creation hook (creation scope receives
    //    { isAnonymous: true }) -> insert into `users`. This is a REAL user
    //    row: the guest's data hangs off it like any other user's.
    // 3. Create a session for the new user and return
    //    { status: "complete", tokens }. Nothing about the session marks it
    //    second-class; only the app's `isAnonymous` field does.
    return todo("signInAnonymously");
  },
});

/**
 * Upgrade the CURRENT anonymous user to an email+password account,
 * preserving its userId and everything attached to it.
 *
 * An action (not a mutation) because password hashing happens here.
 */
export const upgradeAccount = action({
  args: { email: v.string(), password: v.string() },
  returns: vFlowResult,
  handler: async (_ctx, _args) => {
    // TODO(auth-v2):
    // 1. MUST be called while authenticated as an anonymous user: reject
    //    unauthenticated callers and already-upgraded users (throw — this is
    //    a programming error, not a user-facing flow result).
    // 2. Validate the password: length/format -> { status: "error", code:
    //    "PASSWORD_TOO_SHORT" | ... }; breach check -> "PASSWORD_BREACHED".
    // 3. If `email` already belongs to an existing account, return
    //    { status: "error", code: "LINK_CONFLICT", message: "An account
    //    with this email already exists — signing in would abandon this
    //    guest's data; merging is app-defined and out of scope for this
    //    fixture" }. A real app might instead offer the confirmed-linking
    //    flow (see flow-oauth-link) or an app-level data merge here.
    // 4. Otherwise: attach the password credential to the SAME user
    //    (identity.subject — no new `users` row), and flip `isAnonymous` to
    //    false via the app's user-update hook. Email verification is
    //    intentionally skipped in this fixture; a stricter variant would
    //    return { status: "needs", step: "verify-email", flowId } first
    //    (see flow-password-email-verify).
    // 5. Issue NEW tokens for the same userId and return
    //    { status: "complete", tokens } — the client swaps sessions without
    //    the user losing anything.
    return todo("upgradeAccount");
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
