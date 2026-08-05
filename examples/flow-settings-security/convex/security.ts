/**
 * ASPIRATIONAL API — Convex Auth v2 evaluation fixture.
 *
 * The account-security surface for a signed-in user: linked identities
 * (link/unlink), active sessions (revoke, sign-out-everywhere-else), and
 * passkeys (add/rename/remove), all step-up-gated where sensitive.
 * Session plumbing stays in ./auth.ts; this file is the flow-specific API.
 *
 * Function bodies are TODO stubs; each TODO is the behavioral spec the real
 * implementation must satisfy. See ../README.md for acceptance criteria and
 * examples/FLOWS.md for shared conventions.
 */
import { v } from "convex/values";
import { action, mutation, query } from "./_generated/server";
import { todo } from "./authTypes";

/**
 * Result shape shared by the settings mutations that can be refused with a
 * typed, user-showable reason (codes from the registry in examples/FLOWS.md:
 * `LAST_CREDENTIAL`, `REAUTH_REQUIRED`, ...).
 */
const vOkOrError = v.union(
  v.object({ ok: v.literal(true) }),
  v.object({ ok: v.literal(false), code: v.string(), message: v.string() }),
);

// --- Reactive queries (everything scoped to the current user) -------------

export const listIdentities = query({
  args: {},
  returns: v.array(
    v.object({
      id: v.string(),
      provider: v.string(),
      providerLabel: v.string(),
      email: v.optional(v.string()),
      emailVerified: v.optional(v.boolean()),
      linkedAt: v.number(),
      isLastCredential: v.boolean(),
    }),
  ),
  handler: async (_ctx) => {
    // TODO(auth-v2): require authentication; list ONLY the current user's
    // linked identities. `isLastCredential` is true when removing this
    // identity would leave the user without any way to sign in (counting
    // passkeys and other credentials). Reactive: a link/unlink from another
    // tab updates every subscriber live.
    return todo("listIdentities");
  },
});

export const listSessions = query({
  args: {},
  returns: v.array(
    v.object({
      id: v.string(),
      device: v.optional(v.string()),
      lastActiveAt: v.number(),
      createdAt: v.number(),
      isCurrent: v.boolean(),
    }),
  ),
  handler: async (_ctx) => {
    // TODO(auth-v2): require authentication; list ONLY the current user's
    // active sessions, marking the one making this query `isCurrent`.
    // Reactive: a revocation from anywhere removes the row live.
    return todo("listSessions");
  },
});

export const listPasskeys = query({
  args: {},
  returns: v.array(
    v.object({
      id: v.string(),
      name: v.string(),
      createdAt: v.number(),
      lastUsedAt: v.optional(v.number()),
    }),
  ),
  handler: async (_ctx) => {
    // TODO(auth-v2): require authentication; list ONLY the current user's
    // passkeys. Reactive, like the other lists.
    return todo("listPasskeys");
  },
});

// --- Linked identities -----------------------------------------------------

/**
 * Begin linking a new OAuth identity to the CURRENT (signed-in) user.
 * Returns the provider authorization URL for a full-page redirect.
 */
export const startLinkOAuth = action({
  args: {
    provider: v.union(v.literal("google"), v.literal("github")),
    redirectTo: v.string(),
  },
  returns: v.object({ url: v.string() }),
  handler: async (_ctx, _args) => {
    // TODO(auth-v2):
    // 1. Require authentication. Link-intent is derived from the
    //    authenticated session — there is no client-supplied intent
    //    parameter to forge; an unauthenticated caller simply cannot link.
    // 2. REQUIRE recent re-authentication (step-up): if the session's most
    //    recent verification is older than the policy window, throw
    //    `new ConvexError({ code: "REAUTH_REQUIRED" })`. The client
    //    re-proves via `reauthWithPassword` and retries this call.
    // 3. Validate `redirectTo` against the app-origin allowlist; create
    //    hashed-state + PKCE handshake state keyed to the session; return
    //    the provider authorization URL. The auth HTTP callback route
    //    completes the link and 302s back to `redirectTo`.
    return todo("startLinkOAuth");
  },
});

export const unlinkIdentity = mutation({
  args: { identityId: v.string() },
  returns: vOkOrError,
  handler: async (_ctx, _args) => {
    // TODO(auth-v2):
    // 1. Require authentication; the identity must belong to the current
    //    user.
    // 2. Refuse to remove the user's last credential -> { ok: false, code:
    //    "LAST_CREDENTIAL", message }. Locking yourself out must be
    //    structurally impossible server-side — the client's disabled button
    //    is only UX.
    // 3. Require recent re-authentication -> { ok: false, code:
    //    "REAUTH_REQUIRED", message } (an error RETURN here, not a throw —
    //    this surface keeps the union).
    // 4. Unlink; `listIdentities` subscribers update reactively.
    return todo("unlinkIdentity");
  },
});

// --- Sessions ----------------------------------------------------------------

export const revokeSession = mutation({
  args: { sessionId: v.string() },
  returns: v.null(),
  handler: async (_ctx, _args) => {
    // TODO(auth-v2): require authentication; the session must belong to the
    // current user; revoke it. Revocation propagates to that device's live
    // WebSocket connection immediately — it is reactively signed out, not
    // on its next request.
    return todo("revokeSession");
  },
});

export const revokeOtherSessions = mutation({
  args: {},
  returns: v.object({ revoked: v.number() }),
  handler: async (_ctx) => {
    // TODO(auth-v2): require authentication; revoke every session of the
    // current user EXCEPT the one making this call; return the count.
    // Same immediate WebSocket propagation as `revokeSession`.
    return todo("revokeOtherSessions");
  },
});

// --- Passkeys ----------------------------------------------------------------

export const addPasskey = action({
  args: { name: v.string() },
  returns: v.union(
    v.object({ ok: v.literal(true), passkeyId: v.string() }),
    v.object({ ok: v.literal(false), code: v.string(), message: v.string() }),
  ),
  handler: async (_ctx, _args) => {
    // TODO(auth-v2):
    // 1. Require authentication + recent re-authentication -> { ok: false,
    //    code: "REAUTH_REQUIRED", message }.
    // 2. Run the WebAuthn registration ceremony. This fixture collapses the
    //    challenge/attestation round trip into one call; the real API will
    //    need a two-step begin/finish pair (or a client helper hook that
    //    drives `navigator.credentials.create()` between the two).
    // 3. Store the credential under `name`; return { ok: true, passkeyId }.
    return todo("addPasskey");
  },
});

export const renamePasskey = mutation({
  args: { passkeyId: v.string(), name: v.string() },
  returns: v.null(),
  handler: async (_ctx, _args) => {
    // TODO(auth-v2): require authentication; the passkey must belong to the
    // current user; rename it. `listPasskeys` updates reactively.
    return todo("renamePasskey");
  },
});

export const removePasskey = mutation({
  args: { passkeyId: v.string() },
  returns: vOkOrError,
  handler: async (_ctx, _args) => {
    // TODO(auth-v2): require authentication; the passkey must belong to the
    // current user. Same structural rules as `unlinkIdentity`: if this
    // passkey is the user's only credential -> { ok: false, code:
    // "LAST_CREDENTIAL", message }; stale verification -> { ok: false,
    // code: "REAUTH_REQUIRED", message }.
    return todo("removePasskey");
  },
});

// --- Step-up -----------------------------------------------------------------

/**
 * Re-prove the password to refresh the CURRENT session's verification
 * timestamp. No new session, no new tokens, no reconnect.
 */
export const reauthWithPassword = action({
  args: { password: v.string() },
  returns: vOkOrError,
  handler: async (_ctx, _args) => {
    // TODO(auth-v2):
    // 1. Require authentication; rate limit attempts -> { ok: false, code:
    //    "RATE_LIMITED", message }.
    // 2. Verify `password` -> { ok: false, code: "INVALID_CREDENTIALS",
    //    message } on mismatch.
    // 3. On success, refresh the CURRENT session's verification timestamp
    //    in place — no new session is created, no tokens are issued, and
    //    the WebSocket does not reconnect. Step-up-gated calls then succeed
    //    for the policy window.
    return todo("reauthWithPassword");
  },
});
