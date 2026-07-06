/**
 * SCIM provisioning-cycle tests (audit finding H16 — SCIM was config/validate
 * only; no provisioning-cycle/reconciliation test).
 *
 * The SCIM HTTP handler (bearer auth + filter parsing + RFC-7644 serialization)
 * ultimately drives three component mutations: it creates a `GroupMember`,
 * flips its `status` on a PATCH `active:false`, and records a
 * `GroupConnectionScimIdentity` linking the external IdP id to the local user
 * (keyed `(connectionId, resourceType, externalId)`, upserted). These are the
 * durable state changes an SSO admin relies on, and they run in-memory here via
 * `convexTest` against the component — no Docker, no HTTP.
 *
 * NOT covered here (interop / HTTP-layer only — flagged in the H16 report):
 * SCIM bearer-token auth, the SCIM filter grammar (`userName eq ...`), and the
 * RFC-7644 request/response serialization, all of which live in the HTTP action
 * and need the Docker interop suite (or a `t.fetch` HTTP-router test). The
 * webhook-delivery *signature scheme* is also interop-only: the HMAC is
 * computed inline inside `createGroupService` (server/connection/group/
 * service.ts), not exposed as a pure function, and reconstructing it in a test
 * would only assert a copy of the scheme, not the real one.
 */

import { components } from "@convex/_generated/api";
import schema from "@convex/schema";
import { expect, test } from "vite-plus/test";

import { convexTest } from "../convex/setup";

/**
 * `member.get` is overloaded (single lookup or batched array), so its return
 * type is a union; the single-id / single-pair calls here always resolve to one
 * doc, narrowed via this shape.
 */
type MemberDoc = { _id: string; status?: string; userId: string } | null;

/** Seed a group + an active SCIM-capable connection, mirroring replay.test.ts. */
async function seedConnection(t: ReturnType<typeof convexTest>) {
  return await t.run(async (ctx) => {
    const groupId = await ctx.runMutation(components.auth.group.create, {
      name: "SCIM Org",
      slug: "scim-org",
      type: "organization",
    });
    const connectionId = await ctx.runMutation(components.auth.connection.create, {
      groupId,
      slug: "scim-conn",
      name: "SCIM Connection",
      protocol: "oidc",
      status: "active",
    });
    return { groupId, connectionId };
  });
}

test("SCIM create-user provisions a membership and a linked SCIM identity", async () => {
  const t = convexTest(schema);
  const { groupId, connectionId } = await seedConnection(t);

  const { userId, memberId, identityId } = await t.run(async (ctx) => {
    // POST /Users: create the local user...
    const userId = (await ctx.runMutation(components.auth.user.create, {
      data: { email: "provisioned@example.com", name: "Provisioned User" },
    })) as never;
    // ...add them to the connection's group...
    const memberId = await ctx.runMutation(components.auth.group.member.create, {
      groupId,
      userId,
      status: "active",
    });
    // ...and record the external-id <-> user link.
    const identityId = await ctx.runMutation(components.auth.connection.scim.identity.upsert, {
      connectionId,
      groupId,
      resourceType: "user",
      externalId: "okta-user-001",
      userId,
      active: true,
      lastProvisionedAt: Date.now(),
    });
    return { userId, memberId, identityId };
  });

  // Membership now exists and is discoverable by (groupId, userId).
  const membership = (await t.run((ctx) =>
    ctx.runQuery(components.auth.group.member.get, { groupId, userId }),
  )) as MemberDoc;
  expect(membership?._id).toBe(memberId);
  expect(membership?.status).toBe("active");
  expect(identityId).toBeTruthy();
});

test("SCIM PATCH active:false deactivates the membership (status flip)", async () => {
  const t = convexTest(schema);
  const { groupId } = await seedConnection(t);

  const { userId, memberId } = await t.run(async (ctx) => {
    const userId = (await ctx.runMutation(components.auth.user.create, {
      data: { email: "deactivate@example.com" },
    })) as never;
    const memberId = await ctx.runMutation(components.auth.group.member.create, {
      groupId,
      userId,
      status: "active",
    });
    return { userId, memberId };
  });

  // PATCH /Users/{id} with { active: false } maps to a status patch.
  await t.run((ctx) =>
    ctx.runMutation(components.auth.group.member.update, {
      id: memberId,
      patch: { status: "inactive" },
    }),
  );

  const updated = (await t.run((ctx) =>
    ctx.runQuery(components.auth.group.member.get, { id: memberId }),
  )) as MemberDoc;
  expect(updated?.status).toBe("inactive");

  // A status-filtered list is how "filter active members" is served; the now
  // inactive member must not appear in the active set.
  const activeMembers = await t.run((ctx) =>
    ctx.runQuery(components.auth.group.member.list, {
      where: { groupId, status: "active" },
      paginationOpts: { cursor: null, numItems: 50 },
    }),
  );
  expect(activeMembers.page.some((m: { userId: string }) => m.userId === userId)).toBe(false);
});

test("SCIM identity upsert is idempotent on (connectionId, resourceType, externalId)", async () => {
  const t = convexTest(schema);
  const { groupId, connectionId } = await seedConnection(t);

  const userId = (await t.run((ctx) =>
    ctx.runMutation(components.auth.user.create, {
      data: { email: "idem@example.com" },
    }),
  )) as never;

  const first = await t.run((ctx) =>
    ctx.runMutation(components.auth.connection.scim.identity.upsert, {
      connectionId,
      groupId,
      resourceType: "user",
      externalId: "azure-guid-42",
      userId,
      active: true,
    }),
  );

  // A repeat provision for the same external id must patch the SAME row, not
  // create a duplicate (SCIM re-sends are routine).
  const second = await t.run((ctx) =>
    ctx.runMutation(components.auth.connection.scim.identity.upsert, {
      connectionId,
      groupId,
      resourceType: "user",
      externalId: "azure-guid-42",
      userId,
      active: false,
    }),
  );
  expect(second).toBe(first);

  const identities = await t.run((ctx) =>
    ctx.runQuery(components.auth.connection.scim.identity.list, {
      connectionId,
      paginationOpts: { cursor: null, numItems: 50 },
    }),
  );
  expect(identities.page).toHaveLength(1);
  expect(identities.page[0].active).toBe(false);
});

test("member.create rejects a duplicate membership for the same user", async () => {
  const t = convexTest(schema);
  const { groupId } = await seedConnection(t);

  const userId = (await t.run((ctx) =>
    ctx.runMutation(components.auth.user.create, { data: { email: "dupe@example.com" } }),
  )) as never;

  await t.run((ctx) =>
    ctx.runMutation(components.auth.group.member.create, { groupId, userId, status: "active" }),
  );

  await expect(
    t.run((ctx) =>
      ctx.runMutation(components.auth.group.member.create, { groupId, userId, status: "active" }),
    ),
  ).rejects.toThrow(/DUPLICATE_MEMBERSHIP|already a member/);
});
