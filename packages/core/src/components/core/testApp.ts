import { vOnSignIn, vOnSignUp } from "../../lib/types";
import { internalMutation } from "./_generated/server";
import { Infer, v } from "convex/values";

/**
 * Test-only spy state. The core calls the app's `onSignUp` when it first sees an
 * identity and its (optional) `onSignIn` when a known account returns, and the
 * suite needs to assert that. convex-test runs the whole suite in one process,
 * so module-level logs are a stable spy; the readers and reset below are plain
 * functions the test imports directly, since there's no reason to round-trip
 * through the test deployment to read in-process state. This file is excluded
 * from the published build, so the global state never reaches production.
 */
type OnSignUpCall = Infer<typeof vOnSignUp>;
type OnSignInCall = Infer<typeof vOnSignIn>;
const onSignUpCalls: OnSignUpCall[] = [];
const onSignInCalls: OnSignInCall[] = [];

/** Read the recorded `onSignUp` calls (test-only). */
export function getOnSignUpCalls(): readonly OnSignUpCall[] {
  return onSignUpCalls;
}

/** Read the recorded `onSignIn` calls (test-only). */
export function getOnSignInCalls(): readonly OnSignInCall[] {
  return onSignInCalls;
}

/** Clear the recorded calls so a test can assert in isolation (test-only). */
export function resetUserCallbackCalls(): void {
  onSignUpCalls.length = 0;
  onSignInCalls.length = 0;
}

/**
 * Stand-in for the app's sign-up callback, used only by the core's isolated
 * test suite. Like a minimal real app it owns no users table, and just echoes
 * the provider-scoped account id back as the app user id.
 */
export const onSignUp = internalMutation({
  args: vOnSignUp,
  returns: v.string(),
  handler: async (_ctx, args) => {
    onSignUpCalls.push({ ...args });
    return args.providerAccountId;
  },
});

/**
 * Stand-in for the app's sign-in callback: the core invokes it when a known
 * account signs in again, and it returns nothing.
 */
export const onSignIn = internalMutation({
  args: vOnSignIn,
  returns: v.null(),
  handler: async (_ctx, args) => {
    onSignInCalls.push({ ...args });
    return null;
  },
});
