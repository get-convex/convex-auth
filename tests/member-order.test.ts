/**
 * Regression: `member.list({ orderBy: "status" })` actually sorts by status
 * (orderBy-honoring — audit finding). The handler previously accepted `orderBy`
 * but never referenced it, so a caller asking for status order silently got
 * creation-time order. `member.list` now selects the `group_id_status` index so
 * a group-scoped list is genuinely ordered by status.
 */

import { components } from "@convex/_generated/api";
import schema from "@convex/schema";
import { expect, test } from "vite-plus/test";

import { convexTest } from "./convex/setup";

test("member.list honors orderBy: 'status' (group-scoped)", async () => {
  const t = convexTest(schema);

  const { groupId } = await t.run(async (ctx) => {
    const groupId = await ctx.runMutation(components.auth.group.create, {
      name: "Acme",
      slug: "acme",
    });
    const users = ["u-active", "u-invited", "u-suspended"];
    // Insert in an order that does NOT match status order, so a pass-through
    // (creation-time) result would fail the assertion below.
    const statuses = ["suspended", "active", "invited"];
    for (let i = 0; i < users.length; i++) {
      const userId = await ctx.runMutation(components.auth.user.create, {
        data: { email: `${users[i]}@example.com` },
      });
      await ctx.runMutation(components.auth.group.member.create, {
        groupId,
        userId,
        status: statuses[i],
        roleIds: [],
      });
    }
    return { groupId };
  });

  const asc = (await t.run((ctx) =>
    ctx.runQuery(components.auth.group.member.list, {
      where: { groupId },
      paginationOpts: { numItems: 10, cursor: null },
      orderBy: "status",
      order: "asc",
    }),
  )) as { page: Array<{ status: string }> };

  const statusesInOrder = asc.page.map((m) => m.status);
  // Ascending status order — proves the ordering is by status, not insertion time.
  expect(statusesInOrder).toEqual([...statusesInOrder].sort());
  expect(statusesInOrder).toEqual(["active", "invited", "suspended"]);
});
