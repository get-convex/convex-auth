import { components } from "@convex/_generated/api";
import schema from "@convex/schema";
import { expect, test } from "vite-plus/test";

import { convexTest } from "./convex/setup";

/**
 * Regression tests for the paginated group cascades (perf/growth cluster,
 * item 3). The refactor drains the subtree a budgeted batch at a time across
 * scheduled continuations; a normal (small) subtree completes inline in the
 * first transaction, so these tests do not depend on the scheduler. They lock
 * in that the whole subtree is still deleted / re-stamped and that unrelated
 * trees are untouched.
 */

async function createUser(t: any, email: string) {
  return await t.run(async (ctx: any) => {
    return await ctx.runMutation(components.auth.user.create, { data: { email } });
  });
}

test("group.remove cascade-deletes the whole subtree (groups, members, invites)", async () => {
  const t = convexTest(schema);
  const userId = await createUser(t, "cascade@example.com");

  const ids = await t.run(async (ctx: any) => {
    const root = await ctx.runMutation(components.auth.group.create, {
      name: "Root",
      type: "organization",
    });
    const a = await ctx.runMutation(components.auth.group.create, {
      name: "A",
      parentGroupId: root,
    });
    const b = await ctx.runMutation(components.auth.group.create, {
      name: "B",
      parentGroupId: root,
    });
    const a1 = await ctx.runMutation(components.auth.group.create, {
      name: "A1",
      parentGroupId: a,
    });
    await ctx.runMutation(components.auth.group.member.create, { groupId: a1, userId });
    await ctx.runMutation(components.auth.group.invite.create, {
      groupId: b,
      tokenHash: "th-cascade-1",
      status: "pending",
    });
    return { root, a, b, a1 };
  });

  // A sibling tree that must survive the cascade untouched.
  const survivor = await t.run(async (ctx: any) => {
    const s = await ctx.runMutation(components.auth.group.create, {
      name: "Survivor",
      type: "organization",
    });
    await ctx.runMutation(components.auth.group.member.create, { groupId: s, userId });
    return s;
  });

  await t.run(async (ctx: any) => {
    await ctx.runMutation(components.auth.group.remove, { id: ids.root });
  });

  const remaining = await t.run(async (ctx: any) => {
    return await Promise.all(
      [ids.root, ids.a, ids.b, ids.a1].map((id: string) =>
        ctx.runQuery(components.auth.group.get, { id }),
      ),
    );
  });
  expect(remaining).toEqual([null, null, null, null]);

  const membersOfA1 = await t.run(async (ctx: any) =>
    ctx.runQuery(components.auth.group.member.list, {
      where: { groupId: ids.a1 },
      paginationOpts: { numItems: 10, cursor: null },
    }),
  );
  expect(membersOfA1.page).toHaveLength(0);

  const invitesOfB = await t.run(async (ctx: any) =>
    ctx.runQuery(components.auth.group.invite.list, {
      where: { groupId: ids.b },
      paginationOpts: { numItems: 10, cursor: null },
    }),
  );
  expect(invitesOfB.page).toHaveLength(0);

  const survivorDoc = await t.run(async (ctx: any) =>
    ctx.runQuery(components.auth.group.get, { id: survivor }),
  );
  expect(survivorDoc).not.toBeNull();
  const survivorMembers = await t.run(async (ctx: any) =>
    ctx.runQuery(components.auth.group.member.list, {
      where: { groupId: survivor },
      paginationOpts: { numItems: 10, cursor: null },
    }),
  );
  expect(survivorMembers.page).toHaveLength(1);
});

test("group.update re-parent re-stamps rootGroupId across the moved subtree", async () => {
  const t = convexTest(schema);

  const { root1, root2, child, grandchild } = await t.run(async (ctx: any) => {
    const root1 = await ctx.runMutation(components.auth.group.create, {
      name: "Root1",
      type: "organization",
    });
    const root2 = await ctx.runMutation(components.auth.group.create, {
      name: "Root2",
      type: "organization",
    });
    const child = await ctx.runMutation(components.auth.group.create, {
      name: "Child",
      parentGroupId: root1,
    });
    const grandchild = await ctx.runMutation(components.auth.group.create, {
      name: "Grandchild",
      parentGroupId: child,
    });
    return { root1, root2, child, grandchild };
  });

  // Sanity: everything under root1 initially.
  const before = await t.run(async (ctx: any) =>
    ctx.runQuery(components.auth.group.get, { id: grandchild }),
  );
  expect(before.rootGroupId).toBe(root1);

  // Move `child` (and its subtree) under root2.
  await t.run(async (ctx: any) => {
    await ctx.runMutation(components.auth.group.update, {
      id: child,
      patch: { parentGroupId: root2 },
    });
  });

  const [childDoc, grandchildDoc] = await t.run(async (ctx: any) =>
    Promise.all([
      ctx.runQuery(components.auth.group.get, { id: child }),
      ctx.runQuery(components.auth.group.get, { id: grandchild }),
    ]),
  );
  expect(childDoc.rootGroupId).toBe(root2);
  expect(childDoc.parentGroupId).toBe(root2);
  expect(grandchildDoc.rootGroupId).toBe(root2); // re-stamped through the cascade
});
