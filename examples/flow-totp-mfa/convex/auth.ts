/**
 * ASPIRATIONAL API — Convex Auth v2 evaluation fixture.
 *
 * Use case: password sign-in that dynamically requires a TOTP second factor
 * when the account has one enrolled, plus enrollment (QR secret + one-time
 * backup codes) and backup-code sign-in. Whether a second factor is required
 * is decided per-account, server-side — the client learns it only from the
 * returned union.
 *
 * Function bodies are TODO stubs; each TODO is the behavioral spec the real
 * implementation must satisfy. See ../README.md for acceptance criteria and
 * examples/FLOWS.md for shared conventions.
 */
import { v } from "convex/values";
import { action, mutation } from "./_generated/server";
import { todo, vFlowResult, vTokenBundle } from "./authTypes";

/**
 * Sign in with email + password. Accounts with TOTP enrolled get a second
 * step instead of a session.
 */
export const signIn = action({
  args: { email: v.string(), password: v.string() },
  returns: vFlowResult,
  handler: async (_ctx, _args) => {
    // TODO(auth-v2):
    // 1. Rate limit attempts per account and per caller -> "RATE_LIMITED".
    // 2. Wrong email OR wrong password -> the same "INVALID_CREDENTIALS"
    //    error (do not distinguish; enumeration resistance).
    // 3. Password correct and the account has TOTP enrolled: park the
    //    verified-password state on the flow and return { status: "needs",
    //    step: "totp", flowId }. NO session exists yet — abandoning here
    //    leaves the user signed out. The decision is per-account and
    //    server-side; the client learns it only from this union.
    // 4. Password correct, no TOTP -> { status: "complete", tokens }.
    return todo("signIn");
  },
});

/** Satisfy the second factor with a code from the authenticator app. */
export const verifyTotp = action({
  args: { flowId: v.string(), code: v.string() },
  returns: vFlowResult,
  handler: async (_ctx, _args) => {
    // TODO(auth-v2):
    // 1. Look up the flow parked at needs:"totp" -> "FLOW_EXPIRED" if
    //    missing/expired.
    // 2. Check the 6-digit code against the enrolled secret with the usual
    //    time-step window, with REPLAY PROTECTION: a given code is consumed
    //    once and can never be accepted again -> "CODE_INVALID".
    // 3. Limited attempts per flow; exceeding them kills the flow ->
    //    "FLOW_EXPIRED" (the user must sign in again).
    // 4. Success: create the session at AAL2 (both factors verified) and
    //    return { status: "complete", tokens }.
    return todo("verifyTotp");
  },
});

/** Satisfy the second factor with a single-use backup code. */
export const useBackupCode = action({
  args: { flowId: v.string(), code: v.string() },
  returns: vFlowResult,
  handler: async (_ctx, _args) => {
    // TODO(auth-v2):
    // 1. Same flow lookup and attempt limiting as verifyTotp.
    // 2. Backup codes are stored hashed at rest and are SINGLE-USE:
    //    consuming one atomically marks it spent -> "CODE_INVALID" for
    //    wrong or already-spent codes.
    // 3. Success completes exactly like verifyTotp (session at AAL2).
    //    `complete` carries no detail, so telling the user how many codes
    //    remain belongs in a lifecycle hook / notification job: email the
    //    user "a backup code was used, N remain" and prompt regeneration
    //    when the count runs low.
    return todo("useBackupCode");
  },
});

/** Begin TOTP enrollment for the signed-in user. */
export const startTotpEnrollment = action({
  args: {},
  returns: v.object({
    enrollmentId: v.string(),
    secret: v.string(),
    otpauthUrl: v.string(),
  }),
  handler: async (_ctx) => {
    // TODO(auth-v2):
    // 1. Requires authentication AND recent re-auth: throw
    //    ConvexError({ code: "REAUTH_REQUIRED", ... }) when the session's
    //    last verification is too old. (Fixture note: the re-auth UX lives
    //    in the flow-step-up example; this client just shows a message.)
    // 2. Generate a secret and store it server-side as a PENDING
    //    enrollment — it is inert and never usable for sign-in until a
    //    live code confirms it.
    // 3. Return { enrollmentId, secret, otpauthUrl } for the client to
    //    render as a QR code.
    return todo("startTotpEnrollment");
  },
});

/** Confirm the pending enrollment with a live code from the authenticator. */
export const confirmTotpEnrollment = action({
  args: { enrollmentId: v.string(), code: v.string() },
  returns: v.union(
    v.object({ ok: v.literal(true), backupCodes: v.array(v.string()) }),
    v.object({ ok: v.literal(false), code: v.string(), message: v.string() }),
  ),
  handler: async (_ctx, _args) => {
    // TODO(auth-v2):
    // 1. Verify a LIVE code against the pending secret — this proves the
    //    authenticator actually has the secret -> { ok: false, code:
    //    "CODE_INVALID", message } otherwise (limited attempts, then the
    //    pending enrollment is discarded).
    // 2. On success the enrollment becomes active (the app flips
    //    users.totpEnrolled via its hook) and freshly generated backup
    //    codes are returned EXACTLY ONCE — they are hashed at rest
    //    thereafter and can never be shown again.
    return todo("confirmTotpEnrollment");
  },
});

/** Turn off the second factor for the signed-in user. */
export const disableTotp = mutation({
  args: {},
  returns: v.null(),
  handler: async (_ctx) => {
    // TODO(auth-v2):
    // 1. Requires authentication AND recent re-auth (throw ConvexError
    //    REAUTH_REQUIRED, as in startTotpEnrollment).
    // 2. Clear the TOTP factor AND all backup codes.
    // 3. A lifecycle hook should notify the user's email — removing a
    //    second factor is a security-sensitive event.
    return todo("disableTotp");
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
