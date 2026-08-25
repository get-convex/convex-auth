import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { convexTest } from "convex-test";
import { register as registerRateLimiter } from "@convex-dev/rate-limiter/test";
import { register as registerBatchWorker } from "@convex-dev/batch-worker/test";
import { api, internal } from "./_generated/api.ts";
import schema from "./schema.ts";
import { seedChallenge } from "./testSetup.ts";
import { WORKER_NAME } from "./sweep.ts";

const modules = import.meta.glob("./**/*.ts");

function setup() {
  const t = convexTest(schema, modules);
  registerRateLimiter(t);
  registerBatchWorker(t);
  return t;
}

const START = new Date("2026-01-01T00:00:00Z").getTime();

async function challengeEmails(t: ReturnType<typeof setup>) {
  return await t.run(async (ctx) =>
    (await ctx.db.query("challenges").collect()).map((row) => row.email),
  );
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(START);
});

afterEach(() => {
  vi.useRealTimers();
});

describe("getDueChallenges", () => {
  test("goes idle with no timeout when the table is empty", async () => {
    const t = setup();
    expect(
      await t.query(internal.sweep.getDueChallenges, { name: WORKER_NAME }),
    ).toEqual({ kind: "idle" });
  });

  test("returns the completed rows first", async () => {
    const t = setup();
    await seedChallenge(t, {
      email: "expired@example.com",
      purpose: "p",
      code: "c1",
      secret: "s1",
      expiresAt: START - 1,
    });
    await seedChallenge(t, {
      email: "completed@example.com",
      userId: "user1",
      purpose: "p",
      code: "c2",
      secret: "s2",
      expiresAt: START + 60_000,
    });
    const completed = await t.mutation(api.challenge.complete, {
      code: "c2",
      secret: "s2",
      purpose: "p",
    });
    expect(completed).toMatchObject({ success: true });

    const result = await t.query(internal.sweep.getDueChallenges, {
      name: WORKER_NAME,
    });
    expect(result).toMatchObject({
      kind: "work",
      cursor: { completedAt: START, expiresAt: 0 },
    });
    const ids = result.kind === "work" ? result.batch.ids : [];
    const rows = await t.run(async (ctx) =>
      Promise.all(ids.map((id) => ctx.db.get("challenges", id))),
    );
    expect(rows.map((row) => row?.email)).toEqual(["completed@example.com"]);
  });

  test("returns only the expired rows, and moves the cursor", async () => {
    const t = setup();
    await seedChallenge(t, {
      email: "expired@example.com",
      purpose: "p",
      code: "c1",
      secret: "s1",
      expiresAt: START - 1000,
    });
    // At exactly `expiresAt` a row is still usable (`expiresAt < now` is the
    // expiry test everywhere), so it is not due yet.
    await seedChallenge(t, {
      email: "boundary@example.com",
      purpose: "p",
      code: "c2",
      secret: "s2",
      expiresAt: START,
    });
    await seedChallenge(t, {
      email: "fresh@example.com",
      purpose: "p",
      code: "c3",
      secret: "s3",
      expiresAt: START + 60_000,
    });

    const result = await t.query(internal.sweep.getDueChallenges, {
      name: WORKER_NAME,
    });
    expect(result).toMatchObject({
      kind: "work",
      cursor: { completedAt: 0, expiresAt: START - 1000 },
    });
    const ids = result.kind === "work" ? result.batch.ids : [];
    expect(ids).toHaveLength(1);
  });

  test("goes idle until the next row expires", async () => {
    const t = setup();
    await seedChallenge(t, {
      email: "a@example.com",
      purpose: "p",
      code: "c1",
      secret: "s1",
      expiresAt: START + 5_000,
    });
    await seedChallenge(t, {
      email: "b@example.com",
      purpose: "p",
      code: "c2",
      secret: "s2",
      expiresAt: START + 60_000,
    });

    expect(
      await t.query(internal.sweep.getDueChallenges, { name: WORKER_NAME }),
    ).toEqual({ kind: "idle", timeoutMs: 5_000 });
  });

  test("the cursor skips rows below it, minus the grace window", async () => {
    const t = setup();
    // Far below the cursor: only a tombstone would be there in production.
    await seedChallenge(t, {
      email: "old@example.com",
      purpose: "p",
      code: "c1",
      secret: "s1",
      expiresAt: START - 600_000,
    });
    // Inside the grace window: re-read.
    await seedChallenge(t, {
      email: "grace@example.com",
      purpose: "p",
      code: "c2",
      secret: "s2",
      expiresAt: START - 200_000 - 30_000,
    });

    const result = await t.query(internal.sweep.getDueChallenges, {
      name: WORKER_NAME,
      cursor: { completedAt: 0, expiresAt: START - 200_000 },
    });
    expect(result).toMatchObject({ kind: "work" });
    const ids = result.kind === "work" ? result.batch.ids : [];
    const rows = await t.run(async (ctx) =>
      Promise.all(ids.map((id) => ctx.db.get("challenges", id))),
    );
    expect(rows.map((row) => row?.email)).toEqual(["grace@example.com"]);
  });
});

describe("deleteChallenges", () => {
  test("deletes the rows of the batch and ignores rows that are gone", async () => {
    const t = setup();
    await seedChallenge(t, {
      email: "a@example.com",
      purpose: "p",
      code: "c1",
      secret: "s1",
    });
    await seedChallenge(t, {
      email: "b@example.com",
      purpose: "p",
      code: "c2",
      secret: "s2",
    });
    const [a, b] = await t.run(async (ctx) =>
      (await ctx.db.query("challenges").collect()).map((row) => row._id),
    );
    await t.run(async (ctx) => ctx.db.delete("challenges", b));

    await t.mutation(internal.sweep.deleteChallenges, { ids: [a, b] });

    expect(await challengeEmails(t)).toEqual([]);
  });
});

describe("the sweep loop", () => {
  test("a completion deletes the completed row after commit, and the expired rows", async () => {
    const t = setup();
    await seedChallenge(t, {
      email: "expired@example.com",
      purpose: "p",
      code: "c1",
      secret: "s1",
      expiresAt: START - 1,
    });
    await seedChallenge(t, {
      email: "completed@example.com",
      userId: "user1",
      purpose: "p",
      code: "c2",
      secret: "s2",
      expiresAt: START + 3_600_000,
    });

    const result = await t.mutation(api.challenge.complete, {
      code: "c2",
      secret: "s2",
      purpose: "p",
    });
    expect(result).toMatchObject({ success: true });
    // The loop runs in scheduled functions; let them all complete.
    await t.finishAllScheduledFunctions(() => vi.runAllTimers());

    expect(await challengeEmails(t)).toEqual([]);
    // The unspent proof is gone with the row.
    expect(
      await t.mutation(api.verifiedEmails.add, {
        proof: result.success ? result.proof : "",
        setPrimary: false,
      }),
    ).toEqual({ success: false, userError: { error: "INVALID_PROOF" } });
  });

  test("a proof spent in the same mutation leaves nothing for the loop", async () => {
    const t = setup();
    await seedChallenge(t, {
      email: "alice@example.com",
      userId: "user1",
      purpose: "p",
      code: "c1",
      secret: "s1",
      expiresAt: START + 3_600_000,
    });

    const result = await t.mutation(api.challenge.complete, {
      code: "c1",
      secret: "s1",
      purpose: "p",
    });
    const added = await t.mutation(api.verifiedEmails.add, {
      proof: result.success ? result.proof : "",
      setPrimary: false,
    });
    expect(added).toMatchObject({ success: true });
    await t.finishAllScheduledFunctions(() => vi.runAllTimers());

    expect(await challengeEmails(t)).toEqual([]);
    expect(
      await t.query(api.verifiedEmails.getEmails, { userId: "user1" }),
    ).toEqual([{ email: "alice@example.com", isPrimary: true }]);
  });
});
