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
import { ErrorCode } from "@robelest/convex-auth/shared/codes";
import { ConvexError } from "convex/values";
import { expect, test } from "vite-plus/test";

import { convexTest } from "../convex/setup";

/**
 * `member.get` is overloaded (single lookup or batched array), so its return
 * type is a union; the single-id / single-pair calls here always resolve to one
 * doc, narrowed via this shape.
 */
type MemberDoc = { _id: string; status?: string; userId: string } | null;

const provisionScimUser = components.auth.connection.scim.identity.provision;

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

test("SCIM user provisioning atomically deduplicates User, Account, and identity", async () => {
  const t = convexTest(schema);
  const { groupId, connectionId } = await seedConnection(t);
  const args = {
    connectionId,
    groupId,
    externalId: "atomic-external-user",
    provider: `oidc:${connectionId}`,
    userData: {
      email: "atomic@example.com",
      emailVerificationTime: Date.now(),
      name: "Atomic SCIM User",
      firstName: "Atomic",
      lastName: "User",
    },
    active: true,
    raw: { userName: "atomic@example.com" },
    lastProvisionedAt: Date.now(),
  };

  const first = (await t.run((ctx) => ctx.runMutation(provisionScimUser, args))) as {
    userId: string;
    created: boolean;
  };
  const retry = (await t.run((ctx) =>
    ctx.runMutation(provisionScimUser, {
      ...args,
      userData: { ...args.userData, name: "Retry profile" },
      lastProvisionedAt: args.lastProvisionedAt + 1,
    }),
  )) as { userId: string; created: boolean };

  expect(first.created).toBe(true);
  expect(retry).toEqual({ userId: first.userId, created: false });

  const { account, identity, accounts, users } = await t.run(async (ctx) => ({
    account: await ctx.runQuery(components.auth.account.get, {
      provider: args.provider,
      providerAccountId: args.externalId,
    }),
    identity: await ctx.runQuery(components.auth.connection.scim.identity.get, {
      connectionId,
      resourceType: "user",
      externalId: args.externalId,
    }),
    accounts: await ctx.runQuery(components.auth.account.list, {
      userId: first.userId as never,
    }),
    users: await ctx.runQuery(components.auth.user.list, {
      paginationOpts: { cursor: null, numItems: 10 },
    }),
  }));

  expect(account?.userId).toBe(first.userId);
  const resolvedIdentity = identity as { userId?: string; lastProvisionedAt?: number } | null;
  expect(resolvedIdentity?.userId).toBe(first.userId);
  expect(resolvedIdentity?.lastProvisionedAt).toBe(args.lastProvisionedAt + 1);
  expect(accounts).toHaveLength(1);
  expect(users.page).toHaveLength(1);
  expect(users.page[0]).toMatchObject({
    name: "Atomic SCIM User",
    firstName: "Atomic",
    lastName: "User",
  });
});

test("SCIM provisioning rejects conflicting existing owners without reassigning either", async () => {
  const t = convexTest(schema);
  const { groupId, connectionId } = await seedConnection(t);
  const provider = `oidc:${connectionId}`;
  const externalId = "conflicting-external-user";
  const { accountUserId, identityUserId } = await t.run(async (ctx) => {
    const accountUserId = await ctx.runMutation(components.auth.user.create, {
      data: { email: "account-owner@example.com" },
    });
    const identityUserId = await ctx.runMutation(components.auth.user.create, {
      data: { email: "identity-owner@example.com" },
    });
    await ctx.runMutation(components.auth.account.create, {
      userId: accountUserId,
      provider,
      providerAccountId: externalId,
    });
    await ctx.runMutation(components.auth.connection.scim.identity.upsert, {
      connectionId,
      groupId,
      resourceType: "user",
      externalId,
      userId: identityUserId,
    });
    return { accountUserId, identityUserId };
  });

  await expect(
    t.run((ctx) =>
      ctx.runMutation(provisionScimUser, {
        connectionId,
        groupId,
        externalId,
        provider,
        userData: { email: "must-not-be-created@example.com" },
      }),
    ),
  ).rejects.toSatisfy(
    (error: unknown) =>
      error instanceof ConvexError &&
      (error.data as { code?: string }).code === ErrorCode.ACCOUNT_ALREADY_LINKED,
  );

  const { account, identity, users } = await t.run(async (ctx) => ({
    account: await ctx.runQuery(components.auth.account.get, {
      provider,
      providerAccountId: externalId,
    }),
    identity: await ctx.runQuery(components.auth.connection.scim.identity.get, {
      connectionId,
      resourceType: "user",
      externalId,
    }),
    users: await ctx.runQuery(components.auth.user.list, {
      paginationOpts: { cursor: null, numItems: 10 },
    }),
  }));
  expect(account?.userId).toBe(accountUserId);
  expect((identity as { userId?: string } | null)?.userId).toBe(identityUserId);
  expect(users.page).toHaveLength(2);
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
