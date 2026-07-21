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

test("oauth refresh: an in-window retry re-points the single child; the client keeps refreshing without a re-login", async () => {
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

  // The token response was dropped, so the client never received rt1 and retries
  // rt0 within the grace window with a freshly-generated successor hash. This is a
  // benign retry: it must succeed WITHOUT forking a second chain, so rt1 (which the
  // client never saw) is dropped and rt1b becomes the single live successor.
  const retry = await t.run(async (ctx) => {
    return await ctx.runMutation(components.auth.oauth.refresh.exchange, {
      tokenHash: "rt0",
      newTokenHash: "rt1b",
      clientId: "oc_retry",
      now: now + 30_000,
      newExpiresAt: now + 30_000 + week,
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
  // No fork: rt0 stays live, rt1 (the tip the client never received) is dropped,
  // and rt1b is the single live successor the retry handed back.
  expect(rt0).not.toBeNull();
  expect(rt1).toBeNull();
  expect(rt1b).not.toBeNull();

  // The retried successor rotates forward normally — the grant is never revoked.
  const advance = await t.run(async (ctx) => {
    return await ctx.runMutation(components.auth.oauth.refresh.exchange, {
      tokenHash: "rt1b",
      newTokenHash: "rt2",
      clientId: "oc_retry",
      now: now + 60_000,
      newExpiresAt: now + 60_000 + week,
      reuseWindowMs: 60_000,
    });
  });
  expect(advance.status).toBe("rotated");
});

test("oauth refresh: replaying a rotated token outside the grace window is reuse, even if the client never advanced", async () => {
  const t = convexTest(schema);
  const userId = await makeUser(t, "oauth-refresh-latereplay@example.com");
  const now = Date.now();
  const week = 7 * 24 * 60 * 60 * 1000;

  await t.run(async (ctx) => {
    return await ctx.runMutation(components.auth.oauth.refresh.create, {
      tokenHash: "lr0",
      clientId: "oc_late",
      userId,
      scopes: ["workspace:read"],
      expiresAt: now + week,
    });
  });

  expect(
    (
      await t.run(async (ctx) => {
        return await ctx.runMutation(components.auth.oauth.refresh.exchange, {
          tokenHash: "lr0",
          newTokenHash: "lr1",
          clientId: "oc_late",
          now,
          newExpiresAt: now + week,
          reuseWindowMs: 60_000,
        });
      })
    ).status,
  ).toBe("rotated");

  // A distinct rotation of an already-used token TEN MINUTES later — long past the
  // grace window — is treated as theft rather than a benign retry: a client that
  // truly retries does so promptly, so an out-of-window replay of a token the
  // holder never advanced past burns the whole grant.
  const late = await t.run(async (ctx) => {
    return await ctx.runMutation(components.auth.oauth.refresh.exchange, {
      tokenHash: "lr0",
      newTokenHash: "lr1b",
      clientId: "oc_late",
      now: now + 10 * 60_000,
      newExpiresAt: now + 10 * 60_000 + week,
      reuseWindowMs: 60_000,
    });
  });
  expect(late).toEqual({ status: "reuse_detected", userId, clientId: "oc_late" });

  const [lr0, lr1, lr1b] = await t.run(async (ctx) => {
    return [
      await ctx.runQuery(components.auth.oauth.refresh.get, { tokenHash: "lr0" }),
      await ctx.runQuery(components.auth.oauth.refresh.get, { tokenHash: "lr1" }),
      await ctx.runQuery(components.auth.oauth.refresh.get, { tokenHash: "lr1b" }),
    ];
  });
  expect(lr0).toBeNull();
  expect(lr1).toBeNull();
  expect(lr1b).toBeNull();
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

test("oauth refresh in-window replays re-point the single child instead of forking", async () => {
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

  // No theft (grant stays live) AND no fork: each in-window replay RE-POINTS id0's
  // single successor to the freshly presented tip, dropping the previous one. Only
  // the latest tip (id1c) survives, so a stolen token can never accumulate a
  // parallel chain of live successors.
  const [id0, id1, id1b, id1c] = await t.run(async (ctx) => {
    return [
      await ctx.runQuery(components.auth.oauth.refresh.get, { tokenHash: "id0" }),
      await ctx.runQuery(components.auth.oauth.refresh.get, { tokenHash: "id1" }),
      await ctx.runQuery(components.auth.oauth.refresh.get, { tokenHash: "id1b" }),
      await ctx.runQuery(components.auth.oauth.refresh.get, { tokenHash: "id1c" }),
    ];
  });
  expect(id0).not.toBeNull();
  expect(id1).toBeNull();
  expect(id1b).toBeNull();
  expect(id1c).not.toBeNull();
});

test("oauth refresh: retrying the exact same rotation (identical newTokenHash) is idempotent", async () => {
  const t = convexTest(schema);
  const userId = await makeUser(t, "oauth-refresh-sameidem@example.com");
  const now = Date.now();

  await t.run(async (ctx) => {
    return await ctx.runMutation(components.auth.oauth.refresh.create, {
      tokenHash: "s0",
      clientId: "oc_same",
      userId,
      scopes: ["workspace:read"],
      expiresAt: now + 60_000,
    });
  });

  const exchange = (newTokenHash: string, when: number) =>
    t.run(async (ctx) => {
      return await ctx.runMutation(components.auth.oauth.refresh.exchange, {
        tokenHash: "s0",
        newTokenHash,
        clientId: "oc_same",
        now: when,
        newExpiresAt: now + 60_000,
        reuseWindowMs: 10_000,
      });
    });

  const first = await exchange("s1", now);
  expect(first.status).toBe("rotated");
  // Replaying the SAME rotation (identical successor hash) is a no-op success — it
  // must not fork, revoke, or otherwise disturb the chain.
  const again = await exchange("s1", now + 1);
  expect(again.status).toBe("rotated");

  const [s0, s1] = await t.run(async (ctx) => {
    return [
      await ctx.runQuery(components.auth.oauth.refresh.get, { tokenHash: "s0" }),
      await ctx.runQuery(components.auth.oauth.refresh.get, { tokenHash: "s1" }),
    ];
  });
  expect(s0).not.toBeNull();
  expect(s1).not.toBeNull();

  // The single successor still rotates forward cleanly after the idempotent retry.
  const advance = await t.run(async (ctx) => {
    return await ctx.runMutation(components.auth.oauth.refresh.exchange, {
      tokenHash: "s1",
      newTokenHash: "s2",
      clientId: "oc_same",
      now: now + 2,
      newExpiresAt: now + 60_000,
      reuseWindowMs: 10_000,
    });
  });
  expect(advance.status).toBe("rotated");
});

test("oauth refresh forbids same-token forking: the second rotation re-points the single child, theft caught once the chain advances", async () => {
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

  // No fork: a second rotation of the SAME parent RE-POINTS fork0's single
  // successor, so only the latest tip survives. A one-time-stolen token can no
  // longer split off a parallel chain that rides forever undetected.
  const [victimChild, attackerChild] = await t.run(async (ctx) => {
    return [
      await ctx.runQuery(components.auth.oauth.refresh.get, { tokenHash: "victimChild" }),
      await ctx.runQuery(components.auth.oauth.refresh.get, { tokenHash: "attackerChild" }),
    ];
  });
  expect(victimChild).toBeNull();
  expect(attackerChild).not.toBeNull();

  // The dropped tip no longer rotates; only the single live successor advances.
  expect((await exchange("victimChild", "victimChild2", now + 2)).status).toBe("invalid");
  expect((await exchange("attackerChild", "attackerChild2", now + 3)).status).toBe("rotated");

  // fork0's successor has now been consumed, so replaying fork0 — even INSIDE the
  // grace window — is unambiguous theft and burns the whole grant (the exact case
  // the old chain-forking logic let ride undetected).
  const theft = await exchange("fork0", "forkX", now + 4);
  expect(theft).toEqual({ status: "reuse_detected", userId, clientId: "oc_fork" });
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

test("oauth refresh: a detected replay revokes every token in the grant family (deep chain)", async () => {
  const t = convexTest(schema);
  const userId = await makeUser(t, "oauth-refresh-family@example.com");
  const now = Date.now();

  await t.run(async (ctx) => {
    return await ctx.runMutation(components.auth.oauth.refresh.create, {
      tokenHash: "f0",
      clientId: "oc_fam",
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
        clientId: "oc_fam",
        now: when,
        newExpiresAt: now + 60_000,
        reuseWindowMs: 10_000,
      });
    });

  // Advance a multi-generation chain: f0 → f1 → f2 → f3.
  expect((await exchange("f0", "f1", now)).status).toBe("rotated");
  expect((await exchange("f1", "f2", now + 1)).status).toBe("rotated");
  expect((await exchange("f2", "f3", now + 2)).status).toBe("rotated");

  // A stolen f0 replayed after the chain advanced trips reuse detection...
  const theft = await exchange("f0", "fx", now + 10_001);
  expect(theft).toEqual({ status: "reuse_detected", userId, clientId: "oc_fam" });

  // ...and every token in the family — including the live tip f3 the real client
  // still holds — now fails closed.
  const [f0, f1, f2, f3, fx] = await t.run(async (ctx) => {
    return [
      await ctx.runQuery(components.auth.oauth.refresh.get, { tokenHash: "f0" }),
      await ctx.runQuery(components.auth.oauth.refresh.get, { tokenHash: "f1" }),
      await ctx.runQuery(components.auth.oauth.refresh.get, { tokenHash: "f2" }),
      await ctx.runQuery(components.auth.oauth.refresh.get, { tokenHash: "f3" }),
      await ctx.runQuery(components.auth.oauth.refresh.get, { tokenHash: "fx" }),
    ];
  });
  expect(f0).toBeNull();
  expect(f1).toBeNull();
  expect(f2).toBeNull();
  expect(f3).toBeNull();
  expect(fx).toBeNull();
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
