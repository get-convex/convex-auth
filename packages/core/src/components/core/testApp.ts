import { vCreateOrUpdateUser } from "../../lib/types";
import { internalMutation } from "./_generated/server";
import { Infer, v } from "convex/values";

/**
 * Test-only spy state. The core calls the app's user callback on every sign-in
 * (with `userId` set for returning identities, unset on first sign-in), and the
 * suite needs to assert that. convex-test runs the whole suite in one process,
 * so a module-level log is a stable spy; the reader and reset below are plain
 * functions the test imports directly, not Convex queries/mutations, since
 * there's no reason to round-trip through the test deployment to read in-process
 * state. This file is excluded from the published build, so the global state
 * never reaches production.
 */
type CreateOrUpdateUserCall = Infer<typeof vCreateOrUpdateUser>;
const createOrUpdateUserCalls: CreateOrUpdateUserCall[] = [];

// Makes a distinct user id for each sign-in that gives neither a user id nor a
// provider account id. A module-level counter (not the call log, which tests
// reset) keeps the ids distinct for the whole suite.
let mintedUserCount = 0;

/** Read the recorded `createOrUpdateUser` calls (test-only). */
export function getCreateOrUpdateUserCalls(): readonly CreateOrUpdateUserCall[] {
  return createOrUpdateUserCalls;
}

/** Clear the recorded calls so a test can assert in isolation (test-only). */
export function resetCreateOrUpdateUserCalls(): void {
  createOrUpdateUserCalls.length = 0;
}

/**
 * Stand-in for the app's user create-or-update callback, used only by the
 * core's isolated test suite. The core invokes this (by function handle) on
 * every sign-in for an identity; like a minimal real app, it owns no users
 * table and just echoes the provider-scoped account id back as the app user id,
 * honoring an explicit `userId` when one is supplied (returning sign-in / link
 * path) and minting an id when the claims give neither.
 */
export const createOrUpdateUser = internalMutation({
  args: vCreateOrUpdateUser,
  returns: v.string(),
  handler: async (_ctx, args) => {
    createOrUpdateUserCalls.push({ ...args });
    if (args.userId !== null) {
      return args.userId;
    }
    return args.providerAccountId ?? `user-${++mintedUserCount}`;
  },
});
