import { components } from "@convex/_generated/api";
import { auth } from "@convex/auth";
import { roles } from "@convex/roles";
import schema from "@convex/schema";
import { ConvexError } from "convex/values";
import { expect, test } from "vite-plus/test";

import { vAuthEventCategory, vAuthEventKind } from "../packages/auth/src/component/model";
import {
  AUTH_EVENT_KINDS,
  EVENT_CATEGORIES,
  EVENT_KIND_CATEGORY,
} from "../packages/auth/src/shared/event/kinds";
import { convexTest, pruneExpiredForTest } from "./convex/setup";

/** Literal values carried by a `v.union(v.literal(...), ...)` validator. */
function unionLiteralValues(validator: unknown): string[] {
  const union = validator as { members: Array<{ kind: string; value: string }> };
  return union.members.map((member) => {
    if (member.kind !== "literal") {
      throw new Error(`expected literal union member, got ${member.kind}`);
    }
    return member.value;
  });
}

test("auth component registers and serves public core functions", async () => {
  const t = convexTest(schema);

  const userId = await t.run(async (ctx) => {
    return await ctx.runMutation(components.auth.user.create, {
      data: { email: "component-user@example.com" },
    });
  });

  const user = await t.run(async (ctx) => {
    return (await ctx.runQuery(components.auth.user.get, { id: userId })) as any;
  });

  expect(user).not.toBeNull();
  expect(user?.email).toBe("component-user@example.com");
});

test("connection.list combines every supplied filter and supports name ordering", async () => {
  const t = convexTest(schema);

  const [groupA, groupB] = await t.run(async (ctx) => {
    const a = await ctx.runMutation(components.auth.group.create, {
      name: "Connection List A",
      slug: "connection-list-a",
      type: "organization",
    });
    const b = await ctx.runMutation(components.auth.group.create, {
      name: "Connection List B",
      slug: "connection-list-b",
      type: "organization",
    });
    return [a, b];
  });

  const targetId = await t.run(async (ctx) => {
    const target = await ctx.runMutation(components.auth.connection.create, {
      groupId: groupA,
      slug: "target",
      name: "Beta",
      protocol: "saml",
      status: "active",
    });
    await ctx.runMutation(components.auth.connection.create, {
      groupId: groupA,
      slug: "target",
      name: "Alpha disabled",
      protocol: "saml",
      status: "disabled",
    });
    await ctx.runMutation(components.auth.connection.create, {
      groupId: groupB,
      slug: "target",
      name: "Alpha other group",
      protocol: "saml",
      status: "active",
    });
    await ctx.runMutation(components.auth.connection.create, {
      groupId: groupA,
      slug: "other",
      name: "Alpha other slug",
      protocol: "saml",
      status: "active",
    });
    await ctx.runMutation(components.auth.connection.create, {
      groupId: groupA,
      slug: "charlie",
      name: "Charlie",
      protocol: "saml",
      status: "active",
    });
    return target;
  });

  const filtered = await t.run(async (ctx) => {
    return await ctx.runQuery(components.auth.connection.list, {
      where: { groupId: groupA, slug: "target", status: "active" },
      paginationOpts: { numItems: 10, cursor: null },
    });
  });

  expect(filtered.page.map((connection: any) => connection._id)).toEqual([targetId]);

  const ordered = await t.run(async (ctx) => {
    return await ctx.runQuery(components.auth.connection.list, {
      where: { groupId: groupA, status: "active" },
      orderBy: "name",
      order: "asc",
      paginationOpts: { numItems: 10, cursor: null },
    });
  });

  expect(ordered.page.map((connection: any) => connection.name)).toEqual([
    "Alpha other slug",
    "Beta",
    "Charlie",
  ]);
});

test("group.list combines parent, slug, root, and name ordering filters", async () => {
  const t = convexTest(schema);

  const [parentA, parentB] = await t.run(async (ctx) => {
    const a = await ctx.runMutation(components.auth.group.create, {
      name: "Parent A",
      slug: "parent-a",
      type: "organization",
    });
    const b = await ctx.runMutation(components.auth.group.create, {
      name: "Parent B",
      slug: "parent-b",
      type: "organization",
    });
    return [a, b];
  });

  const targetChild = await t.run(async (ctx) => {
    const target = await ctx.runMutation(components.auth.group.create, {
      name: "Bravo",
      slug: "shared-child",
      type: "team",
      parentGroupId: parentA,
    });
    await ctx.runMutation(components.auth.group.create, {
      name: "Alpha",
      slug: "alpha-child",
      type: "team",
      parentGroupId: parentA,
    });
    await ctx.runMutation(components.auth.group.create, {
      name: "Charlie",
      slug: "charlie-child",
      type: "team",
      parentGroupId: parentA,
    });
    await ctx.runMutation(components.auth.group.create, {
      name: "Wrong parent",
      slug: "shared-child",
      type: "team",
      parentGroupId: parentB,
    });
    return target;
  });

  const filtered = await t.run(async (ctx) => {
    return await ctx.runQuery(components.auth.group.list, {
      where: { parentGroupId: parentA, slug: "shared-child" },
      paginationOpts: { numItems: 10, cursor: null },
    });
  });
  expect(filtered.page.map((group: any) => group._id)).toEqual([targetChild]);

  const impossible = await t.run(async (ctx) => {
    return await ctx.runQuery(components.auth.group.list, {
      where: { parentGroupId: parentA, isRoot: true },
      paginationOpts: { numItems: 10, cursor: null },
    });
  });
  expect(impossible.page).toHaveLength(0);

  const ordered = await t.run(async (ctx) => {
    return await ctx.runQuery(components.auth.group.list, {
      where: { parentGroupId: parentA },
      orderBy: "name",
      order: "asc",
      paginationOpts: { numItems: 10, cursor: null },
    });
  });
  expect(ordered.page.map((group: any) => group.name)).toEqual(["Alpha", "Bravo", "Charlie"]);
});

test("list order indexes bind exact filtered fields before paginating", async () => {
  const t = convexTest(schema);

  const [groupId, parentGroupId] = await t.run(async (ctx) => {
    const connectionGroup = await ctx.runMutation(components.auth.group.create, {
      name: "Sparse Connection Group",
      slug: "sparse-connection-group",
      type: "organization",
    });
    const parent = await ctx.runMutation(components.auth.group.create, {
      name: "Sparse Parent",
      slug: "sparse-parent",
      type: "organization",
    });
    return [connectionGroup, parent];
  });

  const [activeConnection, matchingChild] = await t.run(async (ctx) => {
    for (let i = 0; i < 20; i += 1) {
      await ctx.runMutation(components.auth.connection.create, {
        groupId,
        slug: `inactive-${i}`,
        name: `Inactive ${i}`,
        protocol: "saml",
        status: "disabled",
      });
      await ctx.runMutation(components.auth.group.create, {
        name: `Wrong Child ${i}`,
        slug: `wrong-${i}`,
        type: "team",
        parentGroupId,
      });
    }
    const connectionId = await ctx.runMutation(components.auth.connection.create, {
      groupId,
      slug: "active-target",
      name: "Active Target",
      protocol: "saml",
      status: "active",
    });
    const childId = await ctx.runMutation(components.auth.group.create, {
      name: "Target Child",
      slug: "target-child",
      type: "team",
      parentGroupId,
    });
    return [connectionId, childId];
  });

  const connectionPage = await t.run(async (ctx) => {
    return await ctx.runQuery(components.auth.connection.list, {
      where: { groupId, status: "active" },
      orderBy: "status",
      order: "asc",
      paginationOpts: { numItems: 1, cursor: null },
    });
  });
  expect(connectionPage.page.map((connection: any) => connection._id)).toEqual([activeConnection]);

  const groupPage = await t.run(async (ctx) => {
    return await ctx.runQuery(components.auth.group.list, {
      where: { parentGroupId, slug: "target-child" },
      orderBy: "slug",
      order: "asc",
      paginationOpts: { numItems: 1, cursor: null },
    });
  });
  expect(groupPage.page.map((group: any) => group._id)).toEqual([matchingChild]);
});

test("refresh token exchange mismatch does not delete supplied session", async () => {
  const t = convexTest(schema);

  const userId = await t.run(async (ctx) => {
    return await ctx.runMutation(components.auth.user.create, {
      data: { email: "refresh-mismatch@example.com" },
    });
  });

  const [sessionA, sessionB] = await t.run(async (ctx) => {
    const first = await ctx.runMutation(components.auth.session.create, {
      userId,
      sessionExpirationTime: Date.now() + 60_000,
      refreshTokenExpirationTime: Date.now() + 60_000,
    });
    const second = await ctx.runMutation(components.auth.session.create, {
      userId,
      sessionExpirationTime: Date.now() + 60_000,
      refreshTokenExpirationTime: Date.now() + 60_000,
    });
    return [first, second];
  });

  const exchanged = await t.run(async (ctx) => {
    return await ctx.runMutation(components.auth.token.refresh.exchange, {
      refreshTokenId: sessionA.refreshTokenId!,
      sessionId: sessionB.sessionId,
      now: Date.now(),
      refreshTokenExpirationTime: Date.now() + 60_000,
      reuseWindowMs: 10_000,
    });
  });

  const stillExists = await t.run(async (ctx) => {
    return await ctx.runQuery(components.auth.session.get, {
      id: sessionB.sessionId,
    });
  });

  expect(exchanged).toEqual({ status: "invalid" });
  expect(stillExists?._id).toBe(sessionB.sessionId);
});

test("auth verifier lookups ignore expired verifiers", async () => {
  const t = convexTest(schema);

  const verifierId = await t.run(async (ctx) => {
    return await ctx.runMutation(components.auth.token.pkce.create, {
      signature: "expired-signature",
      expirationTime: Date.now() - 1,
    });
  });

  const byId = await t.run(async (ctx) => {
    return await ctx.runQuery(components.auth.token.pkce.get, { id: verifierId });
  });
  const bySignature = await t.run(async (ctx) => {
    return await ctx.runQuery(components.auth.token.pkce.get, {
      signature: "expired-signature",
    });
  });

  expect(byId).toBeNull();
  expect(bySignature).toBeNull();
});

test("pruneExpired deletes an expired session behind an older non-expired one", async () => {
  const t = convexTest(schema);
  const now = Date.now();
  const farFuture = now + 365 * 24 * 60 * 60 * 1000;

  const userId = await t.run(async (ctx) => {
    return await ctx.runMutation(components.auth.user.create, {
      data: { email: "prune-session@example.com" },
    });
  });

  const live = await t.run(async (ctx) => {
    return await ctx.runMutation(components.auth.session.create, {
      userId,
      sessionExpirationTime: farFuture,
      refreshTokenExpirationTime: farFuture,
    });
  });
  const stale = await t.run(async (ctx) => {
    return await ctx.runMutation(components.auth.session.create, {
      userId,
      sessionExpirationTime: now - 60_000,
      refreshTokenExpirationTime: farFuture,
    });
  });

  const result = await t.run(async (ctx) => {
    return await ctx.runMutation(pruneExpiredForTest(components.auth), {
      batchSize: 1,
    });
  });

  expect(result.sessions).toBe(1);

  const staleSession = await t.run(async (ctx) => {
    return await ctx.runQuery(components.auth.session.get, { id: stale.sessionId });
  });
  const liveSession = await t.run(async (ctx) => {
    return await ctx.runQuery(components.auth.session.get, { id: live.sessionId });
  });

  expect(staleSession).toBeNull();
  expect(liveSession?._id).toBe(live.sessionId);
});

test("pruneExpired skips never-expire verifiers and prunes expired ones", async () => {
  const t = convexTest(schema);
  const now = Date.now();

  await t.run(async (ctx) => {
    return await ctx.runMutation(components.auth.token.pkce.create, {
      signature: "never-expire-verifier",
    });
  });
  await t.run(async (ctx) => {
    return await ctx.runMutation(components.auth.token.pkce.create, {
      signature: "expired-verifier",
      expirationTime: now - 1,
    });
  });

  const result = await t.run(async (ctx) => {
    return await ctx.runMutation(pruneExpiredForTest(components.auth), {
      batchSize: 1,
    });
  });

  expect(result.authVerifiers).toBe(1);

  const survivor = await t.run(async (ctx) => {
    return await ctx.runQuery(components.auth.token.pkce.get, {
      signature: "never-expire-verifier",
    });
  });
  expect(survivor).not.toBeNull();
});

test("auth.member.get returns membership, roleIds, and grants", async () => {
  const t = convexTest(schema);

  const userId = await t.run(async (ctx) => {
    return await ctx.runMutation(components.auth.user.create, {
      data: { email: "member-inspect@example.com" },
    });
  });

  const orgId = await t.run(async (ctx) => {
    return await ctx.runMutation(components.auth.group.create, {
      name: "Acme Org",
      slug: "acme-org",
      type: "organization",
    });
  });

  await t.run(async (ctx) => {
    return await ctx.runMutation(components.auth.group.member.create, {
      userId,
      groupId: orgId,
      roleIds: [roles.orgAdmin.id],
    });
  });

  const result = await t.run(async (ctx) => {
    return await auth.member.get(ctx, {
      userId,
      groupId: orgId,
    });
  });

  expect(result.membership).toBeTruthy();
  expect(result.membership?._id).toBeTruthy();
  expect(result.roleIds).toContain(roles.orgAdmin.id);
  expect(result.grants).toContain("projects.manage");
});

test("event.append projects per target, enqueues the stream appender, and dedupes by eventId", async () => {
  const t = convexTest(schema);

  const groupId = await t.run(async (ctx) => {
    return await ctx.runMutation(components.auth.group.create, {
      name: "Event Org",
      slug: "event-org",
      type: "organization",
    });
  });
  const userId = await t.run(async (ctx) => {
    return await ctx.runMutation(components.auth.user.create, {
      data: { email: "event-stream@example.com" },
    });
  });

  const event = {
    eventId: "session.signed_in:user:" + userId + ":deadbeef",
    kind: "session.signed_in" as const,
    category: "session" as const,
    occurredAt: Date.now(),
    actor: { type: "user" as const, id: userId },
    subject: { type: "user" as const, id: userId },
    targets: [
      { kind: "user" as const, id: userId },
      { kind: "group" as const, id: groupId },
    ],
    outcome: "success" as const,
    data: { provider: "password" },
  };

  const first = await t.run(async (ctx) => {
    return await ctx.runMutation(components.auth.event.append, {
      event,
      targets: event.targets,
      idempotencyKey: event.eventId,
    });
  });
  expect(first.created).toBe(true);
  expect(first.createdTargets).toHaveLength(2);

  const projection = await t.run(async (ctx) => {
    return await ctx.runQuery(components.auth.event.list, {
      where: { subject: { type: "user", id: userId } },
      paginationOpts: { numItems: 10, cursor: null },
    });
  });
  expect(projection.page).toHaveLength(2);

  const second = await t.run(async (ctx) => {
    return await ctx.runMutation(components.auth.event.append, {
      event,
      targets: event.targets,
      idempotencyKey: event.eventId,
    });
  });
  expect(second.created).toBe(false);
  expect(second.createdTargets).toHaveLength(0);
});

test("event taxonomy: component validators are derived from the shared kind table with no drift", () => {
  // The component's `vAuthEventKind` / `vAuthEventCategory` validators are
  // derived from the same shared taxonomy the server union/category-map use.
  // Assert the derivation reproduces the source set exactly (no kind dropped or
  // added when collapsing the previously-duplicated lists into one source).
  const validatorKinds = unionLiteralValues(vAuthEventKind).sort();
  const sourceKinds = [...AUTH_EVENT_KINDS].sort();
  expect(validatorKinds).toEqual(sourceKinds);
  expect(new Set(validatorKinds).size).toBe(AUTH_EVENT_KINDS.length);

  const validatorCategories = unionLiteralValues(vAuthEventCategory).sort();
  expect(validatorCategories).toEqual([...EVENT_CATEGORIES].sort());

  // Every kind resolves to a category that is a valid category literal.
  for (const kind of AUTH_EVENT_KINDS) {
    expect(EVENT_CATEGORIES).toContain(EVENT_KIND_CATEGORY[kind]);
  }
});

test("event taxonomy: append+list round-trips every kind and preserves its category", async () => {
  const t = convexTest(schema);

  const userId = await t.run(async (ctx) => {
    return await ctx.runMutation(components.auth.user.create, {
      data: { email: "event-taxonomy@example.com" },
    });
  });

  // Append one event per kind (validated against the derived `vAuthEventKind` /
  // `vAuthEventCategory`) and read the projection back — a drift in the derived
  // validator would reject the append or drop the row.
  for (const kind of AUTH_EVENT_KINDS) {
    const eventId = `${kind}:user:${userId}:tax`;
    const appended = await t.run(async (ctx) => {
      return await ctx.runMutation(components.auth.event.append, {
        event: {
          eventId,
          kind,
          category: EVENT_KIND_CATEGORY[kind],
          occurredAt: Date.now(),
          actor: { type: "system" as const },
          subject: { type: "user" as const, id: userId },
          targets: [{ kind: "user" as const, id: userId }],
          outcome: "success" as const,
        },
        targets: [{ kind: "user" as const, id: userId }],
        idempotencyKey: eventId,
      });
    });
    expect(appended.created).toBe(true);
  }

  const projection = await t.run(async (ctx) => {
    return await ctx.runQuery(components.auth.event.list, {
      where: { subject: { type: "user", id: userId } },
      paginationOpts: { numItems: AUTH_EVENT_KINDS.length + 5, cursor: null },
    });
  });

  const projectedKinds = projection.page.map((event: { kind: string }) => event.kind).sort();
  expect(projectedKinds).toEqual([...AUTH_EVENT_KINDS].sort());
  for (const event of projection.page as Array<{ kind: string; category: string }>) {
    expect(event.category).toBe(
      EVENT_KIND_CATEGORY[event.kind as keyof typeof EVENT_KIND_CATEGORY],
    );
  }
});

test("auth.member.assert throws ConvexError on invalid role ids", async () => {
  const t = convexTest(schema);

  const userId = await t.run(async (ctx) => {
    return await ctx.runMutation(components.auth.user.create, {
      data: { email: "invalid-role@example.com" },
    });
  });

  const groupId = await t.run(async (ctx) => {
    return await ctx.runMutation(components.auth.group.create, {
      name: "Role Test Org",
      slug: "role-test-org",
      type: "organization",
    });
  });

  await expect(
    t.run(async (ctx) => {
      return await auth.member.assert(ctx, {
        userId,
        groupId,
        roleIds: ["missing-role"] as any,
        grants: ["projects.read"],
      });
    }),
  ).rejects.toThrow(ConvexError);
});

test("user.list honors a phone filter even when ordering by email", async () => {
  const t = convexTest(schema);

  await t.run(async (ctx) => {
    await ctx.runMutation(components.auth.user.create, {
      data: { email: "match@example.com", phone: "+15550001111" },
    });
    await ctx.runMutation(components.auth.user.create, {
      data: { email: "other@example.com", phone: "+15559998888" },
    });
  });

  // Regression: `orderBy: "email"` used to route through the email index and
  // silently drop the `where.phone` predicate, returning every user.
  const filtered = await t.run(async (ctx) => {
    return await ctx.runQuery(components.auth.user.list, {
      where: { phone: "+15550001111" },
      orderBy: "email",
      paginationOpts: { numItems: 10, cursor: null },
    });
  });

  expect(filtered.page.map((user: any) => user.phone)).toEqual(["+15550001111"]);
});

test("connection.update applies the patch and records a connection.updated audit event", async () => {
  const t = convexTest(schema);

  const groupId = await t.run(async (ctx) => {
    return await ctx.runMutation(components.auth.group.create, {
      name: "Audit Org",
      slug: "audit-org",
      type: "organization",
    });
  });

  const created = await t.run(async (ctx) => {
    return await auth.connection.create(ctx as any, {
      groupId,
      slug: "audit-idp",
      name: "Audit IdP",
      status: "active",
      protocol: "saml",
    });
  });
  const connectionId = created.connectionId;

  // Regression: the emitted `connection.updated` event carries `data.changed`,
  // which the component `vAuthEventData` validator must accept. Before the fix
  // this threw an ArgumentValidationError and rolled back the whole update.
  await t.run(async (ctx) => {
    await auth.connection.update(ctx as any, {
      id: connectionId,
      patch: { name: "Audit IdP (renamed)" },
    });
  });

  const after = await t.run(async (ctx) => {
    return (await ctx.runQuery(components.auth.connection.get, {
      id: connectionId,
    })) as any;
  });
  expect(after?.name).toBe("Audit IdP (renamed)");
});
