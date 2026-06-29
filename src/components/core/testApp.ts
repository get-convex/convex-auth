import { vAccountResolution } from "../../lib/types";
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
type CreateOrUpdateUserCall = Infer<typeof vAccountResolution>;
const createOrUpdateUserCalls: CreateOrUpdateUserCall[] = [];

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
 * path).
 */
export const createOrUpdateUser = internalMutation({
  args: vAccountResolution,
  returns: v.string(),
  handler: async (_ctx, args) => {
    createOrUpdateUserCalls.push({ ...args });
    return args.userId ?? args.providerAccountId;
  },
});
