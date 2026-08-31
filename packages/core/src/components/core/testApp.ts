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

/**
 * The shape of an evaluating `onSignIn` call, mirroring what the core sends
 * to `evaluateSignInHandle` (test-only).
 */
export const vEvaluateSignIn = v.object({
  ...vOnSignIn.fields,
  facts: v.any(),
});
type EvaluateSignInCall = Infer<typeof vEvaluateSignIn>;
const evaluateSignInCalls: EvaluateSignInCall[] = [];

/** Read the recorded evaluator calls (test-only). */
export function getEvaluateSignInCalls(): readonly EvaluateSignInCall[] {
  return evaluateSignInCalls;
}

/** Clear the recorded evaluator calls (test-only). */
export function resetEvaluateSignInCalls(): void {
  evaluateSignInCalls.length = 0;
}

const vTestVerdict = v.union(
  v.null(),
  v.object({
    status: v.literal("requirements-needed"),
    requirements: v.array(
      v.object({ kind: v.string(), data: v.optional(v.any()) }),
    ),
  }),
);

/**
 * Stand-in for an app's evaluating `onSignIn`: demands the `verified` fact,
 * accepting the sign-in only once a verification endpoint has recorded it.
 */
export const evaluateSignIn = internalMutation({
  args: vEvaluateSignIn,
  returns: vTestVerdict,
  handler: async (_ctx, args) => {
    evaluateSignInCalls.push({ ...args });
    const facts = args.facts as Record<string, unknown>;
    if (facts.verified === undefined) {
      return {
        status: "requirements-needed" as const,
        requirements: [{ kind: "test:verify", data: { hint: "prove it" } }],
      };
    }
    return null;
  },
});

/** An evaluator that accepts every sign-in outright (test-only). */
export const evaluateSignInAlwaysComplete = internalMutation({
  args: vEvaluateSignIn,
  returns: vTestVerdict,
  handler: async (_ctx, args) => {
    evaluateSignInCalls.push({ ...args });
    return null;
  },
});

/**
 * An evaluator that always throws, for asserting that a rejected first
 * sign-in rolls back everything the same call created (test-only).
 */
export const evaluateSignInThatThrows = internalMutation({
  args: vEvaluateSignIn,
  returns: vTestVerdict,
  handler: async () => {
    throw new Error("no sign-ins for you");
  },
});

/**
 * A `createUser` that mints the user id from the profile instead of echoing
 * the provider account id — what the `USE_USER_ID_AS_ACCOUNT_ID` tests need,
 * since there the incoming account id is the empty placeholder (test-only).
 */
export const createUserFromProfileName = internalMutation({
  args: vCreateUser,
  returns: v.string(),
  handler: async (_ctx, args) => {
    createUserCalls.push({ ...args });
    return (args.profile as { name: string }).name;
  },
});
