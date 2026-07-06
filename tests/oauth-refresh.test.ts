import { components } from "@convex/_generated/api";
import schema from "@convex/schema";
import { expect, test } from "vite-plus/test";

import { convexTest } from "./convex/setup";

async function makeUser(t: ReturnType<typeof convexTest>, email: string) {
  return await t.run(async (ctx) => {
    return await ctx.runMutation(components.auth.user.create, { data: { email } });
  });
}

test("oauth refresh exchange rotates, then flags reuse outside the window and revokes the chain", async () => {
  const t = convexTest(schema);
  const userId = await makeUser(t, "oauth-refresh-theft@example.com");
  const now = Date.now();

  await t.run(async (ctx) => {
    return await ctx.runMutation(components.auth.oauth.refresh.create, {
      tokenHash: "h0",
      clientId: "oc_theft",
      userId,
      scopes: ["workspace:read"],
      expiresAt: now + 60_000,
    });
  });

  const rotated = await t.run(async (ctx) => {
    return await ctx.runMutation(components.auth.oauth.refresh.exchange, {
      tokenHash: "h0",
      newTokenHash: "h1",
      clientId: "oc_theft",
      now,
      newExpiresAt: now + 60_000,
      reuseWindowMs: 10_000,
    });
  });
  expect(rotated).toEqual({ status: "rotated", userId, scopes: ["workspace:read"] });

  // Advance the chain (h1 → h2) so h0's direct child h1 is no longer the active
  // unused token — a later replay of h0 is then unambiguous theft.
  await t.run(async (ctx) => {
    return await ctx.runMutation(components.auth.oauth.refresh.exchange, {
      tokenHash: "h1",
      newTokenHash: "h2",
      clientId: "oc_theft",
      now,
      newExpiresAt: now + 60_000,
      reuseWindowMs: 10_000,
    });
  });

  const theft = await t.run(async (ctx) => {
    return await ctx.runMutation(components.auth.oauth.refresh.exchange, {
      tokenHash: "h0",
      newTokenHash: "h0x",
      clientId: "oc_theft",
      now: now + 10_001,
      newExpiresAt: now + 60_000,
      reuseWindowMs: 10_000,
    });
  });
  expect(theft).toEqual({ status: "reuse_detected", userId, clientId: "oc_theft" });

  const [h0, h1, h2] = await t.run(async (ctx) => {
    return [
      await ctx.runQuery(components.auth.oauth.refresh.get, { tokenHash: "h0" }),
      await ctx.runQuery(components.auth.oauth.refresh.get, { tokenHash: "h1" }),
      await ctx.runQuery(components.auth.oauth.refresh.get, { tokenHash: "h2" }),
    ];
  });
  expect(h0).toBeNull();
  expect(h1).toBeNull();
  expect(h2).toBeNull();
});

test("oauth refresh exchange tolerates an in-window replay and leaves invalid tokens intact", async () => {
  const t = convexTest(schema);
  const userId = await makeUser(t, "oauth-refresh-inwindow@example.com");
  const now = Date.now();

  await t.run(async (ctx) => {
    return await ctx.runMutation(components.auth.oauth.refresh.create, {
      tokenHash: "iw0",
      clientId: "oc_inwin",
      userId,
      scopes: ["workspace:read"],
      expiresAt: now + 60_000,
    });
  });

  const first = await t.run(async (ctx) => {
    return await ctx.runMutation(components.auth.oauth.refresh.exchange, {
      tokenHash: "iw0",
      newTokenHash: "iw1",
      clientId: "oc_inwin",
      now,
      newExpiresAt: now + 60_000,
      reuseWindowMs: 10_000,
    });
  });
  expect(first.status).toBe("rotated");

  const replay = await t.run(async (ctx) => {
    return await ctx.runMutation(components.auth.oauth.refresh.exchange, {
      tokenHash: "iw0",
      newTokenHash: "iw1b",
      clientId: "oc_inwin",
      now: now + 1,
      newExpiresAt: now + 60_000,
      reuseWindowMs: 10_000,
    });
  });
  expect(replay.status).toBe("rotated");
  const stillLive = await t.run(async (ctx) => {
    return await ctx.runQuery(components.auth.oauth.refresh.get, { tokenHash: "iw0" });
  });
  expect(stillLive).not.toBeNull();

  const unknown = await t.run(async (ctx) => {
    return await ctx.runMutation(components.auth.oauth.refresh.exchange, {
      tokenHash: "ghost",
      newTokenHash: "ghost-child",
      clientId: "oc_inwin",
      now,
      newExpiresAt: now + 60_000,
      reuseWindowMs: 10_000,
    });
  });
  expect(unknown).toEqual({ status: "invalid" });

  const mismatch = await t.run(async (ctx) => {
    return await ctx.runMutation(components.auth.oauth.refresh.exchange, {
      tokenHash: "iw0",
      newTokenHash: "iw-other",
      clientId: "oc_other",
      now,
      newExpiresAt: now + 60_000,
      reuseWindowMs: 10_000,
    });
  });
  expect(mismatch).toEqual({ status: "invalid" });
  const notBurned = await t.run(async (ctx) => {
    return await ctx.runQuery(components.auth.oauth.refresh.get, { tokenHash: "iw0" });
  });
  expect(notBurned).not.toBeNull();
});

test("oauth refresh tolerates a long-delayed retry when the client never rotated forward (MCP re-auth fix)", async () => {
  const t = convexTest(schema);
  const userId = await makeUser(t, "oauth-refresh-retry@example.com");
  const now = Date.now();
  const week = 7 * 24 * 60 * 60 * 1000;

  await t.run(async (ctx) => {
    return await ctx.runMutation(components.auth.oauth.refresh.create, {
      tokenHash: "rt0",
      clientId: "oc_retry",
      userId,
      scopes: ["workspace:read"],
      expiresAt: now + week,
    });
  });

  const first = await t.run(async (ctx) => {
    return await ctx.runMutation(components.auth.oauth.refresh.exchange, {
      tokenHash: "rt0",
      newTokenHash: "rt1",
      clientId: "oc_retry",
      now,
      newExpiresAt: now + week,
      reuseWindowMs: 60_000,
    });
  });
  expect(first.status).toBe("rotated");

  // The token response was lost, so the client never used rt1 and retries rt0 ten
  // minutes later — far outside the grace window. Because the client never rotated
  // past rt0 (rt1 is still unused), this is a benign retry, not theft: the grant
  // must stay live rather than force a re-login.
  const retry = await t.run(async (ctx) => {
    return await ctx.runMutation(components.auth.oauth.refresh.exchange, {
      tokenHash: "rt0",
      newTokenHash: "rt1b",
      clientId: "oc_retry",
      now: now + 10 * 60_000,
      newExpiresAt: now + 10 * 60_000 + week,
      reuseWindowMs: 60_000,
    });
  });
  expect(retry.status).toBe("rotated");

  const [rt0, rt1, rt1b] = await t.run(async (ctx) => {
    return [
      await ctx.runQuery(components.auth.oauth.refresh.get, { tokenHash: "rt0" }),
      await ctx.runQuery(components.auth.oauth.refresh.get, { tokenHash: "rt1" }),
      await ctx.runQuery(components.auth.oauth.refresh.get, { tokenHash: "rt1b" }),
    ];
  });
  expect(rt0).not.toBeNull();
  expect(rt1).not.toBeNull();
  expect(rt1b).not.toBeNull();
});

test("oauth refresh revoke revokes the grant so every token in the chain fails closed", async () => {
  const t = convexTest(schema);
  const userId = await makeUser(t, "oauth-refresh-revoke@example.com");
  const now = Date.now();

  await t.run(async (ctx) => {
    return await ctx.runMutation(components.auth.oauth.refresh.create, {
      tokenHash: "rv0",
      clientId: "oc_rev",
      userId,
      scopes: ["workspace:read"],
      expiresAt: now + 60_000,
    });
  });
  await t.run(async (ctx) => {
    return await ctx.runMutation(components.auth.oauth.refresh.exchange, {
      tokenHash: "rv0",
      newTokenHash: "rv1",
      clientId: "oc_rev",
      now,
      newExpiresAt: now + 60_000,
      reuseWindowMs: 10_000,
    });
  });

  const revoked = await t.run(async (ctx) => {
    return await ctx.runMutation(components.auth.oauth.refresh.revoke, { tokenHash: "rv0" });
  });
  expect(revoked).toEqual({ userId, clientId: "oc_rev" });

  const [rv0, rv1] = await t.run(async (ctx) => {
    return [
      await ctx.runQuery(components.auth.oauth.refresh.get, { tokenHash: "rv0" }),
      await ctx.runQuery(components.auth.oauth.refresh.get, { tokenHash: "rv1" }),
    ];
  });
  expect(rv0).toBeNull();
  expect(rv1).toBeNull();

  const missing = await t.run(async (ctx) => {
    return await ctx.runMutation(components.auth.oauth.refresh.revoke, { tokenHash: "absent" });
  });
  expect(missing).toBeNull();
});

test("oauth refresh replay keeps every issued tip valid — no poisoning, no theft", async () => {
  const t = convexTest(schema);
  const userId = await makeUser(t, "oauth-refresh-idempotent@example.com");
  const now = Date.now();

  await t.run(async (ctx) => {
    return await ctx.runMutation(components.auth.oauth.refresh.create, {
      tokenHash: "id0",
      clientId: "oc_idem",
      userId,
      scopes: ["workspace:read"],
      expiresAt: now + 60_000,
    });
  });

  for (const [replayHash, when] of [
    ["id1", now],
    ["id1b", now + 1],
    ["id1c", now + 2],
  ] as const) {
    const replay = await t.run(async (ctx) => {
      return await ctx.runMutation(components.auth.oauth.refresh.exchange, {
        tokenHash: "id0",
        newTokenHash: replayHash,
        clientId: "oc_idem",
        now: when,
        newExpiresAt: now + 60_000,
        reuseWindowMs: 10_000,
      });
    });
    expect(replay.status).toBe("rotated");
  }

  // No theft (grant stays live). Each replay mints a fresh child WITHOUT deleting
  // the earlier tips, so a client that received ANY of them can still rotate —
  // the fix for clients that retry after a dropped/slow token response.
  const [id0, id1, id1b, id1c] = await t.run(async (ctx) => {
    return [
      await ctx.runQuery(components.auth.oauth.refresh.get, { tokenHash: "id0" }),
      await ctx.runQuery(components.auth.oauth.refresh.get, { tokenHash: "id1" }),
      await ctx.runQuery(components.auth.oauth.refresh.get, { tokenHash: "id1b" }),
      await ctx.runQuery(components.auth.oauth.refresh.get, { tokenHash: "id1c" }),
    ];
  });
  expect(id0).not.toBeNull();
  expect(id1).not.toBeNull();
  expect(id1b).not.toBeNull();
  expect(id1c).not.toBeNull();
});

test("oauth refresh same-token fork keeps both tips live, theft caught once the chain advances", async () => {
  const t = convexTest(schema);
  const userId = await makeUser(t, "oauth-refresh-fork@example.com");
  const now = Date.now();

  await t.run(async (ctx) => {
    return await ctx.runMutation(components.auth.oauth.refresh.create, {
      tokenHash: "fork0",
      clientId: "oc_fork",
      userId,
      scopes: ["workspace:read"],
      expiresAt: now + 60_000,
    });
  });

  const exchange = (tokenHash: string, newTokenHash: string, when: number) =>
    t.run(async (ctx) => {
      return await ctx.runMutation(components.auth.oauth.refresh.exchange, {
        tokenHash,
        newTokenHash,
        clientId: "oc_fork",
        now: when,
        newExpiresAt: now + 60_000,
        reuseWindowMs: 10_000,
      });
    });

  const victim = await exchange("fork0", "victimChild", now);
  const attacker = await exchange("fork0", "attackerChild", now + 1);
  expect(victim.status).toBe("rotated");
  expect(attacker.status).toBe("rotated");

  // No poisoning: a same-token fork leaves BOTH children usable, so whichever
  // token the real client actually persisted still works.
  const [victimChild, attackerChild] = await t.run(async (ctx) => {
    return [
      await ctx.runQuery(components.auth.oauth.refresh.get, { tokenHash: "victimChild" }),
      await ctx.runQuery(components.auth.oauth.refresh.get, { tokenHash: "attackerChild" }),
    ];
  });
  expect(victimChild).not.toBeNull();
  expect(attackerChild).not.toBeNull();

  // Both tips rotate independently while the fork is unresolved.
  expect((await exchange("victimChild", "victimChild2", now + 2)).status).toBe("rotated");
  expect((await exchange("attackerChild", "attackerChild2", now + 3)).status).toBe("rotated");

  // Once the chain has advanced past the shared parent, replaying it outside the
  // grace window is unambiguous theft and burns the whole grant.
  const theft = await exchange("fork0", "forkX", now + 10_001);
  expect(theft.status).toBe("reuse_detected");
  const attackerChild2 = await t.run(async (ctx) => {
    return await ctx.runQuery(components.auth.oauth.refresh.get, { tokenHash: "attackerChild2" });
  });
  expect(attackerChild2).toBeNull();
});

test("oauth refresh replay after the chain advanced (outside the window) is theft", async () => {
  const t = convexTest(schema);
  const userId = await makeUser(t, "oauth-refresh-advanced@example.com");
  const now = Date.now();

  await t.run(async (ctx) => {
    return await ctx.runMutation(components.auth.oauth.refresh.create, {
      tokenHash: "adv0",
      clientId: "oc_adv",
      userId,
      scopes: ["workspace:read"],
      expiresAt: now + 60_000,
    });
  });

  const exchange = (tokenHash: string, newTokenHash: string, when: number) =>
    t.run(async (ctx) => {
      return await ctx.runMutation(components.auth.oauth.refresh.exchange, {
        tokenHash,
        newTokenHash,
        clientId: "oc_adv",
        now: when,
        newExpiresAt: now + 60_000,
        reuseWindowMs: 10_000,
      });
    });

  expect((await exchange("adv0", "c1", now)).status).toBe("rotated");
  expect((await exchange("c1", "c2", now + 1)).status).toBe("rotated");

  // adv0's child (c1) has been consumed, so the client provably rotated past
  // adv0; replaying it outside the grace window is unambiguous theft.
  const replay = await exchange("adv0", "cX", now + 10_001);
  expect(replay.status).toBe("reuse_detected");

  const [adv0, c2, cX] = await t.run(async (ctx) => {
    return [
      await ctx.runQuery(components.auth.oauth.refresh.get, { tokenHash: "adv0" }),
      await ctx.runQuery(components.auth.oauth.refresh.get, { tokenHash: "c2" }),
      await ctx.runQuery(components.auth.oauth.refresh.get, { tokenHash: "cX" }),
    ];
  });
  expect(adv0).toBeNull();
  expect(c2).toBeNull();
  expect(cX).toBeNull();
});

test("oauth.refresh.reuse_detected keeps clientId and userId through the projection", async () => {
  const t = convexTest(schema);
  const userId = await makeUser(t, "oauth-refresh-audit@example.com");

  const event = {
    eventId: "oauth.refresh.reuse_detected:user:" + userId + ":deadbeef",
    kind: "oauth.refresh.reuse_detected" as const,
    category: "oauth" as const,
    occurredAt: Date.now(),
    actor: { type: "oauth_client" as const, id: "oc_audit" },
    subject: { type: "user" as const, id: userId },
    targets: [
      { kind: "oauth_client" as const, id: "oc_audit" },
      { kind: "user" as const, id: userId },
    ],
    outcome: "failure" as const,
    data: { clientId: "oc_audit", userId },
  };

  const appended = await t.run(async (ctx) => {
    return await ctx.runMutation(components.auth.event.append, {
      event,
      targets: event.targets,
      idempotencyKey: event.eventId,
    });
  });
  expect(appended.created).toBe(true);

  const projection = await t.run(async (ctx) => {
    return await ctx.runQuery(components.auth.event.list, {
      where: { subject: { type: "user", id: userId } },
      paginationOpts: { numItems: 10, cursor: null },
    });
  });
  const row = projection.page.find(
    (p: { kind: string }) => p.kind === "oauth.refresh.reuse_detected",
  ) as { data?: Record<string, unknown> } | undefined;
  expect(row).toBeDefined();
  expect(row?.data).toMatchObject({ clientId: "oc_audit", userId });
});
