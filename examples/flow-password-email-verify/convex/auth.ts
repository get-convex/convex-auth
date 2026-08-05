/**
 * ASPIRATIONAL API — Convex Auth v2 evaluation fixture.
 *
 * Use case: email + password sign-up where NO user document exists until the
 * email address is verified. The password hash and pending email live in auth
 * storage keyed to the flow, never on a half-created user.
 *
 * Function bodies are TODO stubs; each TODO is the behavioral spec the real
 * implementation must satisfy. See ../README.md for acceptance criteria and
 * examples/FLOWS.md for shared conventions.
 */
import { v } from "convex/values";
import { action, mutation } from "./_generated/server";
import { todo, vFlowResult, vTokenBundle } from "./authTypes";

/**
 * Start an email+password sign-up.
 *
 * Actions (not mutations) because password hashing and email sending happen
 * here.
 */
export const signUp = action({
  args: { email: v.string(), password: v.string() },
  returns: vFlowResult,
  handler: async (_ctx, _args) => {
    // TODO(auth-v2):
    // 1. Validate the password: length/format -> { status: "error", code:
    //    "PASSWORD_TOO_SHORT" | ... }; breach check -> "PASSWORD_BREACHED".
    // 2. Rate limit by email and by caller -> "RATE_LIMITED".
    // 3. If `email` already belongs to a verified account, do NOT reveal it:
    //    email that address a "someone tried to sign up with your email"
    //    notice, and fall through to the same return shape as the success
    //    path (enumeration resistance).
    // 4. Otherwise: store the password hash keyed to this flow (NOT to a
    //    user — no `users` row may exist yet) and email a 6-digit code.
    // 5. Return { status: "needs", step: "verify-email", flowId,
    //    detail: { email, resendAfterMs } }.
    return todo("signUp");
  },
});

/**
 * Consume the emailed verification code and complete the sign-up.
 * Only here — after verification — is the user document created.
 */
export const verifyEmail = action({
  args: { flowId: v.string(), code: v.string() },
  returns: vFlowResult,
  handler: async (_ctx, _args) => {
    // TODO(auth-v2):
    // 1. Look up the pending flow -> "FLOW_EXPIRED" if missing/expired.
    // 2. Check the code: single-use, atomically consumed, limited attempts
    //    -> "CODE_INVALID" (with detail.attemptsRemaining) / "CODE_EXPIRED".
    // 3. On success, invoke the app's user-creation hook (creation scope
    //    receives { email, emailVerified: true }) -> insert into `users`.
    //    This is the FIRST moment a user document may exist.
    // 4. Attach the password credential to the new user, delete flow state,
    //    create a session, and return { status: "complete", tokens }.
    return todo("verifyEmail");
  },
});

/** Re-send the verification code for a pending sign-up flow. */
export const resendVerification = action({
  args: { flowId: v.string() },
  returns: v.union(
    v.object({ ok: v.literal(true), resendAfterMs: v.number() }),
    v.object({ ok: v.literal(false), code: v.string(), message: v.string() }),
  ),
  handler: async (_ctx, _args) => {
    // TODO(auth-v2): rate limit sends ("RATE_LIMITED"), rotate the code,
    // keep the same flowId. "FLOW_EXPIRED" if the flow is gone.
    return todo("resendVerification");
  },
});

/**
 * Sign in with a verified account.
 */
export const signIn = action({
  args: { email: v.string(), password: v.string() },
  returns: vFlowResult,
  handler: async (_ctx, _args) => {
    // TODO(auth-v2):
    // 1. Rate limit attempts per account -> "RATE_LIMITED".
    // 2. Wrong email OR wrong password -> the same "INVALID_CREDENTIALS"
    //    error (do not distinguish; enumeration resistance).
    // 3. Account exists but its email was never verified (abandoned pre-v2
    //    import, etc.) -> re-send a code and return { status: "needs",
    //    step: "verify-email", flowId } so the client reuses the same code
    //    entry UI as sign-up.
    // 4. Success -> { status: "complete", tokens }.
    return todo("signIn");
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
