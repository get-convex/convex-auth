/**
 * ASPIRATIONAL API — Convex Auth v2 evaluation fixture.
 *
 * Use case: sign-up requires app-defined fields (display name, role, a
 * versioned ToS acceptance) validated server-side BEFORE the account exists.
 * Typed rejections propagate to the form, and the same validation serves
 * both orderings: fields collected up front with sign-up, and fields
 * completed after an authentication that arrived without them
 * (the `needs: "onboarding"` leg).
 *
 * Function bodies are TODO stubs; each TODO is the behavioral spec the real
 * implementation must satisfy. See ../README.md for acceptance criteria and
 * examples/FLOWS.md for shared conventions.
 */
import { v } from "convex/values";
import { action, mutation, query } from "./_generated/server";
import { todo, vFlowResult, vTokenBundle } from "./authTypes";

/** The app-defined onboarding fields, validated server-side. */
const vProfile = v.object({
  displayName: v.string(),
  role: v.union(
    v.literal("engineer"),
    v.literal("designer"),
    v.literal("other"),
  ),
  // The ToS version the user accepted, or null if they didn't check the box.
  tosVersion: v.union(v.string(), v.null()),
});

/**
 * Sign up with email + password + the app-defined profile, all in one call.
 * The profile is validated before any account exists.
 */
export const signUp = action({
  args: { email: v.string(), password: v.string(), profile: vProfile },
  returns: vFlowResult,
  handler: async (_ctx, _args) => {
    // TODO(auth-v2):
    // 1. Validate the password: length/format -> { status: "error", code:
    //    "PASSWORD_TOO_SHORT" | ... }; breach check -> "PASSWORD_BREACHED".
    // 2. Validate the profile server-side, BEFORE the account exists:
    //    - `tosVersion` must equal CURRENT_TOS_VERSION ("2026-06"),
    //      otherwise -> { status: "error", code: "TOS_NOT_ACCEPTED" }.
    //    - `displayName` must be 1..50 chars and must not contain "convex"
    //      (case-insensitive), otherwise -> { status: "error", code:
    //      "INVALID_PROFILE", message } with a message naming the field.
    //    A rejection leaves ZERO state behind: no user, no flow.
    // 3. On success, invoke the app's user-creation hook with BOTH the
    //    provider claims and the validated profile — the creation scope
    //    gets the full flow context — and insert into `users` with
    //    displayName, role, and tosAcceptedVersion populated at birth.
    // 4. Email verification is intentionally out of scope for this fixture
    //    (see flow-password-email-verify); return { status: "complete",
    //    tokens } directly.
    return todo("signUp");
  },
});

/**
 * Reactive view of a pending flow, so a client can subscribe and always
 * render the right step.
 */
export const flowStatus = query({
  args: { flowId: v.string() },
  returns: v.union(
    v.object({
      step: v.string(),
      detail: v.optional(v.record(v.string(), v.any())),
    }),
    v.null(),
  ),
  handler: async (_ctx, _args) => {
    // TODO(auth-v2): look up the pending flow and return its current step
    // (plus any user-safe detail). Because this is a query, the client can
    // useQuery it — a reload or a second tab lands on the same step without
    // any client bookkeeping. Return null when the flow is gone (expired or
    // completed).
    return todo("flowStatus");
  },
});

/**
 * Finish a flow parked at `needs: "onboarding"` — e.g. an OAuth sign-in
 * that authenticated but arrived without the required profile fields.
 */
export const completeOnboarding = action({
  args: { flowId: v.string(), profile: vProfile },
  returns: vFlowResult,
  handler: async (_ctx, _args) => {
    // TODO(auth-v2):
    // 1. Look up the flow parked at needs:"onboarding" -> { status:
    //    "error", code: "FLOW_EXPIRED" } if missing/expired.
    // 2. Run the SAME profile validation as signUp (TOS_NOT_ACCEPTED /
    //    INVALID_PROFILE) — one code path serves both orderings.
    // 3. On success, invoke the app's user-creation hook with the provider
    //    claims parked on the flow MERGED with this profile -> insert into
    //    `users`, fully populated.
    // 4. Single-use: consume the flow atomically; a second call with the
    //    same flowId gets "FLOW_EXPIRED". Create a session and return
    //    { status: "complete", tokens }.
    return todo("completeOnboarding");
  },
});

/**
 * fixture-only: stands in for an OAuth redirect that authenticated but
 * lacks required profile fields. Real (not a TODO stub) so the
 * needs-onboarding leg is demoable without an OAuth provider.
 */
export const simulateOAuthArrival = action({
  args: {},
  returns: vFlowResult,
  handler: async () => {
    return {
      status: "needs" as const,
      step: "onboarding" as const,
      flowId: "fixture-oauth-flow",
      detail: { email: "taylor@example.com", name: "Taylor" },
    };
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
