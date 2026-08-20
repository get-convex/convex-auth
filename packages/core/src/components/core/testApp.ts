import { vCreateUser, vOnSignIn } from "../../lib/types.ts";
import { internalMutation } from "./_generated/server.ts";
import { Infer, v } from "convex/values";

/**
 * Test-only spy state. The core calls the app's `createUser` when it first sees
 * an identity and its (optional) `onSignIn` on every sign-in, and the suite
 * needs to assert that. convex-test runs the whole suite in one process,
 * so module-level logs are a stable spy; the readers and reset below are plain
 * functions the test imports directly, since there's no reason to round-trip
 * through the test deployment to read in-process state.
 */
type CreateUserCall = Infer<typeof vCreateUser>;
type OnSignInCall = Infer<typeof vOnSignIn>;
const createUserCalls: CreateUserCall[] = [];
const onSignInCalls: OnSignInCall[] = [];

/** Read the recorded `createUser` calls (test-only). */
export function getCreateUserCalls(): readonly CreateUserCall[] {
  return createUserCalls;
}

/** Read the recorded `onSignIn` calls (test-only). */
export function getOnSignInCalls(): readonly OnSignInCall[] {
  return onSignInCalls;
}

/** Clear the recorded calls so a test can assert in isolation (test-only). */
export function resetUserCallbackCalls(): void {
  createUserCalls.length = 0;
  onSignInCalls.length = 0;
}

/**
 * Stand-in for the app's user-creating callback, used only by the core's
 * isolated test suite. Like a minimal real app it owns no users table, and just
 * echoes the provider-scoped account id back as the app user id.
 */
export const createUser = internalMutation({
  args: vCreateUser,
  returns: v.string(),
  handler: async (_ctx, args) => {
    createUserCalls.push({ ...args });
    return args.providerAccountId;
  },
});

/**
 * Stand-in for the app's sign-in callback: the core invokes it on every sign-in,
 * and it returns nothing.
 */
export const onSignIn = internalMutation({
  args: vOnSignIn,
  returns: v.null(),
  handler: async (_ctx, args) => {
    onSignInCalls.push({ ...args });
    return null;
  },
});

/**
 * An `onSignIn` that always throws, for asserting that a rejected sign-in rolls
 * back everything the same call created.
 */
export const onSignInThatThrows = internalMutation({
  args: vOnSignIn,
  returns: v.null(),
  handler: async () => {
    throw new Error("no sign-ins for you");
  },
});
