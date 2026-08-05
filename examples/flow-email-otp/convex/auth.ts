/**
 * ASPIRATIONAL API — Convex Auth v2 evaluation fixture.
 *
 * Use case: passwordless sign-in. The user enters their email, receives a
 * 6-digit code, and enters it. The user document is created on the FIRST
 * successful verification; returning users resolve to their existing row.
 * New and returning users go through the identical two steps — the client
 * cannot tell them apart.
 *
 * Function bodies are TODO stubs; each TODO is the behavioral spec the real
 * implementation must satisfy. See ../README.md for acceptance criteria and
 * examples/FLOWS.md for shared conventions.
 */
import { v } from "convex/values";
import { action, mutation } from "./_generated/server";
import { todo, vFlowResult, vTokenBundle } from "./authTypes";

/**
 * Request a sign-in code for an email address.
 *
 * An action (not a mutation) because sending email happens here.
 */
export const requestCode = action({
  args: { email: v.string() },
  returns: v.object({ flowId: v.string(), resendAfterMs: v.number() }),
  handler: async (_ctx, _args) => {
    // TODO(auth-v2):
    // 1. ALWAYS succeed with the same return shape, whether or not `email`
    //    has an account (enumeration resistance). The only observable
    //    difference between a new and a returning email is what happens
    //    server-side after `verifyCode` succeeds.
    // 2. Rate limit per email AND per caller. Because the return shape here
    //    is fixed (not `vFlowResult`), rate limiting surfaces as a thrown
    //    ConvexError with `{ code: "RATE_LIMITED" }`; the client treats it
    //    as "wait and retry".
    // 3. Generate a 6-digit code: hashed at rest, single-use, short expiry
    //    (minutes). Store it keyed to the flow — no `users` row is created
    //    or touched here.
    // 4. If a flow for this email is already pending, re-sending keeps the
    //    SAME flowId (rotating the code) so an in-progress code-entry screen
    //    keeps working.
    // 5. Email the code and return { flowId, resendAfterMs }.
    return todo("requestCode");
  },
});

/**
 * Consume the emailed code and complete the sign-in.
 * For a first-time email, the user document is created here — and only here.
 */
export const verifyCode = action({
  args: { flowId: v.string(), code: v.string() },
  returns: vFlowResult,
  handler: async (_ctx, _args) => {
    // TODO(auth-v2):
    // 1. Look up the pending flow -> "FLOW_EXPIRED" if missing/expired.
    // 2. Check the code: single-use, atomically consumed, limited attempts.
    //    Wrong code -> { status: "error", code: "CODE_INVALID", message }
    //    with the remaining attempt count worked into `message` (the error
    //    arm carries only code + message). Exhausting attempts kills the
    //    flow. Stale code -> "CODE_EXPIRED".
    // 3. On success the email is verified. If an account already exists for
    //    it, resolve to that user. Otherwise invoke the app's user-creation
    //    hook (creation scope receives { email, emailVerified: true }) and
    //    insert the `users` row NOW — the first moment it may exist.
    // 4. Delete flow state, create a session, and return
    //    { status: "complete", tokens }.
    return todo("verifyCode");
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
