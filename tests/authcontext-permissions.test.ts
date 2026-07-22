import { expect, test } from "vite-plus/test";

import { getAuthContextForUser } from "../packages/auth/src/server/context";

/**
 * Regression tests for active-group resolution in `getAuthContextForUser`.
 * Group context is useful even when an app defines no grants or roles, so the
 * resolver must never erase `groupId` / `role` merely because its permissions
 * vocabulary is empty.
 */

type StubOpts = {
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
  return { resolver, calls };
}

test("getAuthContextForUser preserves active group and role when no grants are configured", async () => {
  const { resolver, calls } = makeResolver({
    user: { _id: "u1", lastActiveGroup: "g1", email: "a@b.c" },
    memberGet: { membership: { _id: "m1" }, roleIds: ["member"], grants: [] },
  });

  const result = await getAuthContextForUser(resolver, {} as any, "u1");

  expect(calls.userGet).toBe(1); // user read kept
  expect(calls.memberGet).toBe(1);
  expect(calls.memberList).toBe(0);
  expect(result.groupId).toBe("g1");
  expect(result.role).toBe("member");
  expect(result.grants).toEqual([]);
  expect(result.user).toEqual({ _id: "u1", lastActiveGroup: "g1", email: "a@b.c" });
  expect(() => result.assert("x")).toThrow();
});

test("getAuthContextForUser resolves membership when permissions are configured", async () => {
  const { resolver, calls } = makeResolver({
    user: { _id: "u1", lastActiveGroup: "g1" },
    memberGet: { membership: { _id: "m1" }, roleIds: ["admin"], grants: ["issues.read"] },
  });

  const result = await getAuthContextForUser(resolver, {} as any, "u1");

  expect(calls.memberGet).toBe(1);
  expect(result.groupId).toBe("g1");
  expect(result.role).toBe("admin");
  expect(result.grants).toEqual(["issues.read"]);
});

test("getAuthContextForUser falls back to the first membership", async () => {
  const { resolver, calls } = makeResolver({
    user: { _id: "u1" },
    memberList: { page: [{ groupId: "g2", roleIds: ["viewer"], grants: [] }] },
  });

  const result = await getAuthContextForUser(resolver, {} as any, "u1");

  expect(calls.memberGet).toBe(0);
  expect(calls.memberList).toBe(1);
  expect(result.groupId).toBe("g2");
  expect(result.role).toBe("viewer");
});

test("OAuth scopes still cap resolved grants", async () => {
  const { resolver } = makeResolver({
    user: { _id: "u1", lastActiveGroup: "g1" },
    memberGet: {
      membership: { _id: "m1" },
      roleIds: ["admin"],
      grants: ["issues.read", "issues.write"],
    },
  });

  const result = await getAuthContextForUser(resolver, {} as any, "u1", ["issues.read"]);

  expect(result.groupId).toBe("g1");
  expect(result.grants).toEqual(["issues.read"]);
});
