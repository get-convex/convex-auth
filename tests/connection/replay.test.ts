import { components } from "@convex/_generated/api";
import schema from "@convex/schema";
import { expect, test } from "vite-plus/test";

import { convexTest, pruneExpiredForTest } from "../convex/setup";

async function createConnection(t: ReturnType<typeof convexTest>) {
  return await t.run(async (ctx) => {
    const groupId = await ctx.runMutation(components.auth.group.create, {
      name: "Replay Org",
      slug: "replay-org",
      type: "organization",
    });
    const connectionId = await ctx.runMutation(components.auth.connection.create, {
      groupId,
      slug: "replay-saml",
      name: "Replay SAML",
      protocol: "saml",
      status: "active",
    });
    return { groupId, connectionId };
  });
}

test("SAML pending request accept is single-use (replay rejected the second time)", async () => {
  const t = convexTest(schema);
  const { connectionId } = await createConnection(t);
  const now = Date.now();

  await t.run(async (ctx) => {
    await ctx.runMutation(components.auth.connection.saml.request.create, {
      connectionId,
      requestId: "_authn_request_1",
      createdAt: now,
      expiresAt: now + 60_000,
    });
  });

  const first = await t.run((ctx) =>
    ctx.runMutation(components.auth.connection.saml.request.accept, {
      requestId: "_authn_request_1",
      now: now + 1_000,
    }),
  );
  const second = await t.run((ctx) =>
    ctx.runMutation(components.auth.connection.saml.request.accept, {
      requestId: "_authn_request_1",
      now: now + 2_000,
    }),
  );

  expect(first).toBe(true);
  expect(second).toBe(false);
});

test("SAML pending request accept rejects unknown and expired requests", async () => {
  const t = convexTest(schema);
  const { connectionId } = await createConnection(t);
  const now = Date.now();

  const unknown = await t.run((ctx) =>
    ctx.runMutation(components.auth.connection.saml.request.accept, {
      requestId: "_never_created",
      now,
    }),
  );
  expect(unknown).toBe(false);

  await t.run(async (ctx) => {
    await ctx.runMutation(components.auth.connection.saml.request.create, {
      connectionId,
      requestId: "_expired",
      createdAt: now - 120_000,
      expiresAt: now - 60_000,
    });
  });
  const expired = await t.run((ctx) =>
    ctx.runMutation(components.auth.connection.saml.request.accept, {
      requestId: "_expired",
      now,
    }),
  );
  expect(expired).toBe(false);
});

test("SAML pending request accept rejects a mismatched connectionId (cross-connection defense-in-depth)", async () => {
  const t = convexTest(schema);
  const { groupId, connectionId } = await createConnection(t);
  const now = Date.now();

  // A second connection in the same group. A captured InResponseTo minted for
  // `connectionId` must not be consumable while processing this connection.
  const otherConnectionId = await t.run((ctx) =>
    ctx.runMutation(components.auth.connection.create, {
      groupId,
      slug: "replay-saml-2",
      name: "Replay SAML 2",
      protocol: "saml",
      status: "active",
    }),
  );

  await t.run(async (ctx) => {
    await ctx.runMutation(components.auth.connection.saml.request.create, {
      connectionId,
      requestId: "_authn_request_xc",
      createdAt: now,
      expiresAt: now + 60_000,
    });
  });

  // The wrong connection cannot consume the pending request...
  const wrong = await t.run((ctx) =>
    ctx.runMutation(components.auth.connection.saml.request.accept, {
      requestId: "_authn_request_xc",
      now: now + 1_000,
      connectionId: otherConnectionId,
    }),
  );
  expect(wrong).toBe(false);

  // ...and the mismatch does not burn it: the owning connection still accepts.
  const right = await t.run((ctx) =>
    ctx.runMutation(components.auth.connection.saml.request.accept, {
      requestId: "_authn_request_xc",
      now: now + 2_000,
      connectionId,
    }),
  );
  expect(right).toBe(true);
});

test("SAML seen-assertion record rejects a replayed assertion id per connection", async () => {
  const t = convexTest(schema);
  const { connectionId } = await createConnection(t);
  const now = Date.now();

  const firstSeen = await t.run((ctx) =>
    ctx.runMutation(components.auth.connection.saml.assertion.accept, {
      connectionId,
      assertionId: "_assertion_abc",
      expiresAt: now + 300_000,
    }),
  );
  const replay = await t.run((ctx) =>
    ctx.runMutation(components.auth.connection.saml.assertion.accept, {
      connectionId,
      assertionId: "_assertion_abc",
      expiresAt: now + 300_000,
    }),
  );

  expect(firstSeen).toBe(true);
  expect(replay).toBe(false);
});

test("expired SAML replay rows are pruned by maintenance.pruneExpired", async () => {
  const t = convexTest(schema);
  const { connectionId } = await createConnection(t);
  const now = Date.now();

  await t.run(async (ctx) => {
    await ctx.runMutation(components.auth.connection.saml.request.create, {
      connectionId,
      requestId: "_prune_req",
      createdAt: now - 3_600_000,
      expiresAt: now - 3_000_000,
    });
    await ctx.runMutation(components.auth.connection.saml.assertion.accept, {
      connectionId,
      assertionId: "_prune_assertion",
      expiresAt: now - 3_000_000,
    });
  });

  const result = await t.run((ctx) =>
    ctx.runMutation(pruneExpiredForTest(components.auth), { batchSize: 100 }),
  );

  expect(result.samlLoginRequests).toBe(1);
  expect(result.samlSeenAssertions).toBe(1);

  // With the seen-assertion row pruned, the same assertion id records as a
  // first sighting again, confirming the row was actually deleted.
  const recordsAgain = await t.run((ctx) =>
    ctx.runMutation(components.auth.connection.saml.assertion.accept, {
      connectionId,
      assertionId: "_prune_assertion",
      expiresAt: now + 300_000,
    }),
  );
  expect(recordsAgain).toBe(true);
});

test("connection.get by domain ignores unverified domains and resolves once verified", async () => {
  const t = convexTest(schema);
  const { groupId, connectionId } = await createConnection(t);

  const domainId = await t.run((ctx) =>
    ctx.runMutation(components.auth.connection.domain.create, {
      connectionId,
      groupId,
      domain: "victim-corp.com",
      isPrimary: true,
    }),
  );

  const beforeVerify = await t.run((ctx) =>
    ctx.runQuery(components.auth.connection.get, { domain: "victim-corp.com" }),
  );
  expect(beforeVerify).toBeNull();

  await t.run((ctx) =>
    ctx.runMutation(components.auth.connection.domain.verify, {
      id: domainId,
      verifiedAt: Date.now(),
    }),
  );

  const afterVerify = await t.run((ctx) =>
    ctx.runQuery(components.auth.connection.get, { domain: "victim-corp.com" }),
  );
  expect(afterVerify).not.toBeNull();
  expect((afterVerify as { connection: { _id: string } }).connection._id).toBe(connectionId);
});

test("session.revokeForUser deletes every session and its refresh tokens", async () => {
  const t = convexTest(schema);
  const now = Date.now();
  const farFuture = now + 365 * 24 * 60 * 60 * 1000;

  const userId = await t.run((ctx) =>
    ctx.runMutation(components.auth.user.create, {
      data: { email: "revoke@example.com" },
    }),
  );
  const sessionA = await t.run((ctx) =>
    ctx.runMutation(components.auth.session.create, {
      userId,
      sessionExpirationTime: farFuture,
      refreshTokenExpirationTime: farFuture,
    }),
  );
  const sessionB = await t.run((ctx) =>
    ctx.runMutation(components.auth.session.create, {
      userId,
      sessionExpirationTime: farFuture,
      refreshTokenExpirationTime: farFuture,
    }),
  );

  const result = await t.run((ctx) =>
    ctx.runMutation(components.auth.session.revokeForUser, { userId }),
  );
  expect(result.revoked).toBe(2);

  const [a, b, tokens] = await t.run(async (ctx) => {
    const sa = await ctx.runQuery(components.auth.session.get, { id: sessionA.sessionId });
    const sb = await ctx.runQuery(components.auth.session.get, { id: sessionB.sessionId });
    const remainingA = await ctx.runQuery(components.auth.token.refresh.list, {
      sessionId: sessionA.sessionId,
    });
    return [sa, sb, remainingA];
  });
  expect(a).toBeNull();
  expect(b).toBeNull();
  expect(tokens).toEqual([]);
});
