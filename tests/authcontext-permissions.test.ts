import { expect, test } from "vite-plus/test";

import { getAuthContextForUser } from "../packages/auth/src/server/context";

/**
 * Regression tests for the membership short-circuit in `getAuthContextForUser`
 * (perf/growth cluster, item 2). When the app configured no permissions, the
 * per-request membership read is skipped; the user read is always kept, and the
 * default (flag absent) must preserve full resolution so no authorization
 * behavior is weakened. These are pure unit tests over a stub resolver that
 * records which reads were issued — no Convex runtime required.
 */

type StubOpts = {
  permissionsConfigured?: boolean;
  user: unknown;
  memberGet?: { membership: unknown; roleIds: string[]; grants: string[] };
  memberList?: { page: Array<{ groupId: string; roleIds?: string[]; grants?: string[] }> };
};

function makeResolver(opts: StubOpts) {
  const calls = { userGet: 0, memberGet: 0, memberList: 0 };
  const resolver: any = {
    user: {
      get: async () => {
        calls.userGet += 1;
        return opts.user;
      },
    },
    member: {
      get: async () => {
        calls.memberGet += 1;
        return opts.memberGet ?? { membership: null, roleIds: [], grants: [] };
      },
      list: async () => {
        calls.memberList += 1;
        return opts.memberList ?? { page: [] };
      },
    },
  };
  if (opts.permissionsConfigured !== undefined) {
    resolver.permissionsConfigured = opts.permissionsConfigured;
  }
  return { resolver, calls };
}

test("getAuthContextForUser skips the membership read when permissions are not configured", async () => {
  const { resolver, calls } = makeResolver({
    permissionsConfigured: false,
    user: { _id: "u1", lastActiveGroup: "g1", email: "a@b.c" },
    // A membership exists, but it must not be read on the no-permissions path.
    memberGet: { membership: { _id: "m1" }, roleIds: ["admin"], grants: ["x"] },
  });

  const result = await getAuthContextForUser(resolver, {} as any, "u1");

  expect(calls.userGet).toBe(1); // user read kept
  expect(calls.memberGet).toBe(0); // membership read skipped
  expect(calls.memberList).toBe(0);
  expect(result.groupId).toBeNull();
  expect(result.role).toBeNull();
  expect(result.grants).toEqual([]);
  expect(result.user).toEqual({ _id: "u1", lastActiveGroup: "g1", email: "a@b.c" });
  // No grants resolved → assert throws, consistent with "nothing to authorize".
  expect(() => result.assert("x")).toThrow();
});

test("getAuthContextForUser resolves membership when permissions are configured", async () => {
  const { resolver, calls } = makeResolver({
    permissionsConfigured: true,
    user: { _id: "u1", lastActiveGroup: "g1" },
    memberGet: { membership: { _id: "m1" }, roleIds: ["admin"], grants: ["issues.read"] },
  });

  const result = await getAuthContextForUser(resolver, {} as any, "u1");

  expect(calls.memberGet).toBe(1);
  expect(result.groupId).toBe("g1");
  expect(result.role).toBe("admin");
  expect(result.grants).toEqual(["issues.read"]);
});

test("getAuthContextForUser defaults to full resolution when the flag is absent", async () => {
  const { resolver, calls } = makeResolver({
    // No permissionsConfigured property at all — must NOT short-circuit.
    user: { _id: "u1", lastActiveGroup: "g1" },
    memberGet: { membership: { _id: "m1" }, roleIds: ["admin"], grants: ["issues.read"] },
  });

  const result = await getAuthContextForUser(resolver, {} as any, "u1");

  expect(calls.memberGet).toBe(1); // unknown → resolve (no regression)
  expect(result.grants).toEqual(["issues.read"]);
});

test("getAuthContextForUser lets an explicit option override the resolver property", async () => {
  const { resolver, calls } = makeResolver({
    permissionsConfigured: true, // resolver reports configured...
    user: { _id: "u1", lastActiveGroup: "g1" },
    memberGet: { membership: { _id: "m1" }, roleIds: ["admin"], grants: ["x"] },
  });

  // ...but the explicit option wins and skips the membership read.
  const result = await getAuthContextForUser(resolver, {} as any, "u1", undefined, {
    permissionsConfigured: false,
  });

  expect(calls.memberGet).toBe(0);
  expect(result.groupId).toBeNull();
  expect(result.grants).toEqual([]);
});

test("no-permissions short-circuit keeps OAuth-scoped callers at empty grants", async () => {
  const { resolver, calls } = makeResolver({
    permissionsConfigured: false,
    user: { _id: "u1", lastActiveGroup: "g1" },
    memberGet: { membership: { _id: "m1" }, roleIds: ["admin"], grants: ["x"] },
  });

  // Even with OAuth scopes present, the intersection with (absent) grants is [].
  const result = await getAuthContextForUser(resolver, {} as any, "u1", ["x", "y"], {
    permissionsConfigured: false,
  });

  expect(calls.memberGet).toBe(0);
  expect(result.grants).toEqual([]);
});
