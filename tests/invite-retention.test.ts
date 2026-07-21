import { components } from "@convex/_generated/api";
import schema from "@convex/schema";
import { expect, test } from "vite-plus/test";

import { convexTest, pruneExpiredForTest } from "./convex/setup";

/**
 * Regression coverage for the invite retention / prune-starvation fix
 * (component/maintenance.ts + component/group/invite.ts).
 *
 * These run against the component SOURCE (the test project aliases
 * `@robelest/convex-auth` to `packages/auth/src`), so they exercise the patched
 * behavior directly.
 */

test("revoke clears expiresTime so the invite leaves the expiry retention index", async () => {
  const t = convexTest(schema);
  const now = Date.now();

  const inviteId = await t.run(async (ctx) => {
    return await ctx.runMutation(components.auth.group.invite.create, {
      tokenHash: `revoke-clears-${now}`,
      status: "pending",
      expiresTime: now + 60_000,
    });
  });

  await t.run(async (ctx) => {
    return await ctx.runMutation(components.auth.group.invite.revoke, { id: inviteId });
  });

  const invite = (await t.run(async (ctx) => {
    return await ctx.runQuery(components.auth.group.invite.get, { id: inviteId });
  })) as { status: string; expiresTime?: number } | null;

  expect(invite?.status).toBe("revoked");
  // Cleared on the terminal transition so it can no longer pin the front of the
  // `expires_time` index (it is reclaimed by age instead).
  expect(invite?.expiresTime).toBeUndefined();
});

test("pruneExpired reclaims terminal invites still carrying a past expiresTime", async () => {
  const t = convexTest(schema);
  const now = Date.now();

  // A revoked invite that still carries a past `expiresTime` — the legacy shape
  // that the pre-fix prune skipped (it deleted only NON-terminal rows), so such
  // rows pinned the front of the `expires_time` index and starved the scan.
  const terminalId = await t.run(async (ctx) => {
    return await ctx.runMutation(components.auth.group.invite.create, {
      tokenHash: `terminal-past-expiry-${now}`,
      status: "revoked",
      expiresTime: now - 60_000,
    });
  });

  const result = await t.run(async (ctx) => {
    return await ctx.runMutation(pruneExpiredForTest(components.auth), { batchSize: 50 });
  });

  // The pre-fix handler returned invites === 0 here (terminal rows were skipped).
  expect(result.invites).toBeGreaterThanOrEqual(1);

  const invite = await t.run(async (ctx) => {
    return await ctx.runQuery(components.auth.group.invite.get, { id: terminalId });
  });
  expect(invite).toBeNull();
});
