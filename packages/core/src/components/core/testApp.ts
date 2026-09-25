import { internalMutation, internalQuery } from "./_generated/server.ts";
import { Infer, v } from "convex/values";

const vProvider = v.object({
  name: v.string(),
  accountId: v.string(),
  profile: v.any(),
});

const vCreateUser = v.object({
  provider: vProvider,
});

const vOnSignIn = v.object({
  provider: vProvider,
  userId: v.string(),
});

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

const vCheckSignIn = v.object({ userId: v.string(), attemptId: v.string() });
type CheckSignInCall = Infer<typeof vCheckSignIn>;
const checkSignInCalls: CheckSignInCall[] = [];
// Whether `checkTotp` below is satisfied. Off until a test says the user
// verified a code, the way a TOTP component records a verification.
let totpVerified = false;

/** Read the recorded sign-in check calls (test-only). */
export function getCheckSignInCalls(): readonly CheckSignInCall[] {
  return checkSignInCalls;
}

/** Make `checkTotp` report nothing outstanding from now on (test-only). */
export function verifyTotp(): void {
  totpVerified = true;
}

/** Forget the check calls and the TOTP verification (test-only). */
export function resetSignInChecks(): void {
  checkSignInCalls.length = 0;
  totpVerified = false;
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
    return args.provider.accountId;
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

/**
 * Stand-ins for a provider's sign-in checks (see `CheckSignInFn`). The core
 * runs each check a pending sign-in was parked with whenever the client
 * continues it, with the attempt's subject, and reports the requirement
 * name it was parked under while the check returns `false`. These record
 * what they were asked about and answer from their name: `checkTotp` passes
 * once `verifyTotp` is called, `checkEmail` never passes, and
 * `checkSatisfied` always does.
 */
export const checkTotp = internalQuery({
  args: vCheckSignIn,
  returns: v.boolean(),
  handler: async (_ctx, args) => {
    checkSignInCalls.push({ ...args });
    return totpVerified;
  },
});

export const checkEmail = internalQuery({
  args: vCheckSignIn,
  returns: v.boolean(),
  handler: async (_ctx, args) => {
    checkSignInCalls.push({ ...args });
    return false;
  },
});

export const checkSatisfied = internalQuery({
  args: vCheckSignIn,
  returns: v.boolean(),
  handler: async (_ctx, args) => {
    checkSignInCalls.push({ ...args });
    return true;
  },
});
