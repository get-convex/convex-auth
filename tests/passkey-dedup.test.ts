/**
 * Regression: concurrent / duplicate passkey registration must not create two
 * rows for the same `credentialId`.
 *
 * A duplicate row makes `factor.passkey.get({ credentialId })` (a `.unique()`
 * lookup) throw on every later sign-in — a permanent lockout for that
 * credential. `factor.passkey.create` now dedups by `credentialId`: idempotent
 * for the same user, rejected with `ACCOUNT_ALREADY_LINKED` for a different one.
 *
 * `convex-test` runs mutations serially, so this exercises the dedup *logic*
 * (the observable outcome of the OCC-serialized race), not literal concurrency.
 */

import { components } from "@convex/_generated/api";
import schema from "@convex/schema";
import { ConvexError } from "convex/values";
import { expect, test } from "vite-plus/test";

import { convexTest } from "./convex/setup";

const CREDENTIAL_ID = "dedup-credential";

function passkeyArgs(userId: string) {
  return {
    userId: userId as never,
    credentialId: CREDENTIAL_ID,
    publicKey: new ArrayBuffer(32),
    algorithm: -7,
    counter: 0,
    deviceType: "multiDevice",
    backedUp: true,
    createdAt: Date.now(),
  };
}

test("duplicate passkey registration for the same user is idempotent", async () => {
  const t = convexTest(schema);

  const userId = await t.run(async (ctx) => {
    return (await ctx.runMutation(components.auth.user.create, {
      data: { email: "dedup@example.com" },
    })) as string;
  });

  const first = await t.run(async (ctx) => {
    return (await ctx.runMutation(
      components.auth.factor.passkey.create,
      passkeyArgs(userId),
    )) as string;
  });
  const second = await t.run(async (ctx) => {
    return (await ctx.runMutation(
      components.auth.factor.passkey.create,
      passkeyArgs(userId),
    )) as string;
  });

  // Same credential id + same user → same row, no duplicate insert.
  expect(second).toBe(first);

  // The single-row invariant holds: get({ credentialId }).unique() must not throw.
  const found = await t.run(async (ctx) => {
    return await ctx.runQuery(components.auth.factor.passkey.get, {
      credentialId: CREDENTIAL_ID,
    });
  });
  expect(found).not.toBeNull();
  expect((found as { _id: string })._id).toBe(first);

  const all = await t.run(async (ctx) => {
    return await ctx.runQuery(components.auth.factor.passkey.list, {
      userId: userId as never,
    });
  });
  expect(all.length).toBe(1);
});

test("registering an existing credential for a different user is rejected", async () => {
  const t = convexTest(schema);

  const { alice, bob } = await t.run(async (ctx) => {
    const alice = (await ctx.runMutation(components.auth.user.create, {
      data: { email: "alice@example.com" },
    })) as string;
    const bob = (await ctx.runMutation(components.auth.user.create, {
      data: { email: "bob@example.com" },
    })) as string;
    return { alice, bob };
  });

  await t.run(async (ctx) => {
    await ctx.runMutation(components.auth.factor.passkey.create, passkeyArgs(alice));
  });

  const error = await t
    .run(async (ctx) => {
      return await ctx.runMutation(components.auth.factor.passkey.create, passkeyArgs(bob));
    })
    .then(
      () => null,
      (e) => e,
    );
  expect(error).toBeInstanceOf(ConvexError);
  expect((error as ConvexError<{ code: string }>).data.code).toBe("ACCOUNT_ALREADY_LINKED");

  // Still exactly one row — Bob's rejected insert did not create a duplicate,
  // and it still belongs to Alice.
  const found = await t.run(async (ctx) => {
    return await ctx.runQuery(components.auth.factor.passkey.get, {
      credentialId: CREDENTIAL_ID,
    });
  });
  expect((found as { userId: string }).userId).toBe(alice);
});

test("passkey assertion counter acceptance rejects a stale concurrent counter", async () => {
  const t = convexTest(schema);
  const { userId, passkeyId } = await t.run(async (ctx) => {
    const userId = (await ctx.runMutation(components.auth.user.create, {
      data: { email: "counter-race@example.com" },
    })) as string;
    const passkeyId = (await ctx.runMutation(components.auth.factor.passkey.create, {
      ...passkeyArgs(userId),
      credentialId: "counter-race-credential",
      counter: 10,
    })) as string;
    return { userId, passkeyId };
  });

  const first = await t.run((ctx) =>
    ctx.runMutation(components.auth.factor.passkey.acceptAssertion, {
      id: passkeyId as never,
      counter: 11,
      lastUsedAt: Date.now(),
    }),
  );
  const stale = await t.run((ctx) =>
    ctx.runMutation(components.auth.factor.passkey.acceptAssertion, {
      id: passkeyId as never,
      counter: 11,
      lastUsedAt: Date.now() + 1,
    }),
  );

  expect(first).toBe(true);
  expect(stale).toBe(false);
  const stored = await t.run((ctx) =>
    ctx.runQuery(components.auth.factor.passkey.get, { id: passkeyId as never }),
  );
  expect(stored?.counter).toBe(11);
  expect(stored?.userId).toBe(userId);
});
