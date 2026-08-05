/**
 * ASPIRATIONAL API — Convex Auth v2 evaluation fixture.
 *
 * Use case: "Continue with Google/GitHub" sign-in with safe account linking.
 * Auto-link happens only when the OAuth email is verified on BOTH sides
 * (provider assertion and existing account); when trust is insufficient the
 * server demands confirmed linking — prove the existing password account —
 * and links NOTHING until that proof succeeds.
 *
 * Function bodies are TODO stubs; each TODO is the behavioral spec the real
 * implementation must satisfy. See ../README.md for acceptance criteria and
 * examples/FLOWS.md for shared conventions.
 */
import { v } from "convex/values";
import { action, mutation } from "./_generated/server";
import { todo, vFlowResult, vTokenBundle } from "./authTypes";

/**
 * Begin an OAuth sign-in: returns the provider authorization URL for the
 * client to navigate to (full-page redirect).
 */
export const startOAuth = action({
  args: {
    provider: v.union(v.literal("google"), v.literal("github")),
    redirectTo: v.string(),
  },
  returns: v.object({ url: v.string() }),
  handler: async (_ctx, _args) => {
    // TODO(auth-v2):
    // 1. Validate `redirectTo` against an allowlist of app origins — never
    //    redirect to an arbitrary URL.
    // 2. Create the handshake state server-side, keyed to a new flow: a
    //    random `state` (stored HASHED, compared on return) and a PKCE
    //    verifier/challenge pair.
    // 3. Build the provider authorization URL (client id, scopes, state,
    //    code challenge) and return { url }.
    // 4. The provider's callback is handled by an auth HTTP route (not app
    //    code): it validates state, exchanges the code with PKCE, records
    //    the provider profile against the flow, and 302s back to
    //    `redirectTo` with `?flow=<flowId>&outcome=...` query params.
    //    Provider access/refresh tokens never reach the client.
    return todo("startOAuth");
  },
});

/**
 * Complete an OAuth flow after the provider redirect. The client's /callback
 * route calls this exactly once with the `flow` query param.
 */
export const completeOAuth = action({
  args: { flowId: v.string() },
  returns: vFlowResult,
  handler: async (_ctx, _args) => {
    // TODO(auth-v2):
    // 1. Redeem the one-time flow ticket: atomic claim, expiring ->
    //    "FLOW_EXPIRED" if missing, expired, or already claimed. A second
    //    call on the same flowId must get FLOW_EXPIRED, never tokens.
    // 2. Resolve the (provider, subject) identity:
    //    a. Known identity -> its user; create a session and return
    //       { status: "complete", tokens }.
    //    b. Unknown identity whose provider-VERIFIED email matches an
    //       existing account whose email is ALSO verified -> auto-link the
    //       identity to that account, then complete with tokens. Both sides
    //       must be verified; anything less is case (c).
    //    c. Unknown identity whose email matches an account that is NOT
    //       verified (or matches a password account under a policy that
    //       requires confirmation) -> return { status: "needs", step:
    //       "confirm-link", flowId, detail: { maskedEmail, methods:
    //       ["password"] } }. NOTHING is linked yet — the pending identity
    //       stays parked on the flow until `confirmLinkWithPassword`.
    //    d. No match -> create the user via the app's user-creation hook
    //       (receives the provider profile: email, name, ...) -> insert
    //       into `users`, complete with tokens.
    // Note: intent is never a client parameter. Whether this call is a
    // sign-in, a sign-up, or a link is derived server-side from session and
    // account state — a client cannot forge "link" intent.
    return todo("completeOAuth");
  },
});

/**
 * Confirmed linking: prove the existing password account, then — and only
 * then — attach the pending OAuth identity to it.
 */
export const confirmLinkWithPassword = action({
  args: { flowId: v.string(), password: v.string() },
  returns: vFlowResult,
  handler: async (_ctx, _args) => {
    // TODO(auth-v2):
    // 1. Look up the pending confirm-link flow -> "FLOW_EXPIRED" if
    //    missing/expired/already consumed (single-use).
    // 2. Verify `password` against the candidate account's credential:
    //    rate limited -> "RATE_LIMITED"; wrong password ->
    //    "INVALID_CREDENTIALS" (limited attempts).
    // 3. On success, atomically link the pending OAuth identity to that
    //    user, consume the flow, create a session, and return
    //    { status: "complete", tokens }.
    return todo("confirmLinkWithPassword");
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
