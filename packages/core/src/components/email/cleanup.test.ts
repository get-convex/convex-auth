import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { convexTest } from "convex-test";
import { register as registerBatchWorker } from "@convex-dev/batch-worker/test";
import { register as registerRateLimiter } from "@convex-dev/rate-limiter/test";
import { internal } from "./_generated/api.ts";
import schema from "./schema.ts";
import { WORKER_NAME } from "./cleanup.ts";
import { seedChallenge, ADD_EMAIL, CUSTOM } from "./testSetup.ts";

const modules = import.meta.glob("./**/*.ts");

function setup() {
  const t = convexTest(schema, modules);
  registerRateLimiter(t);
  registerBatchWorker(t);
  return t;
}

const START = new Date("2026-01-01T00:00:00Z").getTime();

/** Seed a challenge that expires at `expiresAt`, and return its ID. */
async function insertChallenge(
  t: ReturnType<typeof setup>,
  code: string,
  expiresAt: number,
) {
  await seedChallenge(t, {
    email: `${code}@example.com`,
    purpose: ADD_EMAIL("user1"),
    code,
    secret: "secret",
    expiresAt,
  });
  const row = await t.run(async (ctx) =>
    (await ctx.db.query("challenges").collect()).find(
      (row) => row.email === `${code}@example.com`,
    ),
  );
  return row!._id;
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(START);
});

afterEach(() => {
  vi.useRealTimers();
});

describe("getExpiredChallenges", () => {
  test("goes idle with no timeout when the table is empty", async () => {
    const t = setup();
    const result = await t.query(internal.cleanup.getExpiredChallenges, {
      name: WORKER_NAME,
    });
    expect(result).toEqual({ kind: "idle" });
  });

  test("returns only the challenges that are expired, in expiry order", async () => {
    const t = setup();
    // The rows are created in another order than they expire: a custom
    // challenge with a long TTL can be older than a short one.
    const laterId = await insertChallenge(t, "later", START - 5);
    await insertChallenge(t, "fresh", START + 1);
    const earlierId = await insertChallenge(t, "earlier", START - 10);

    const result = await t.query(internal.cleanup.getExpiredChallenges, {
      name: WORKER_NAME,
    });
    expect(result).toEqual({
      kind: "work",
      batch: { events: [{ id: earlierId }, { id: laterId }] },
      cursor: START - 5,
    });
  });

  test("goes idle until the next challenge expires", async () => {
    const t = setup();
    await insertChallenge(t, "soon", START + 1000);
    await insertChallenge(t, "late", START + 60_000);

    const result = await t.query(internal.cleanup.getExpiredChallenges, {
      name: WORKER_NAME,
    });
    expect(result).toEqual({ kind: "idle", timeoutMs: 1000 });
  });

  test("the cursor skips the rows that the loop already erased", async () => {
    const t = setup();
    // A row that stays below the cursor is a stale read for the loop: only a
    // tombstone can be below the cursor in production.
    await insertChallenge(t, "gone", START - 10);
    const laterId = await insertChallenge(t, "later", START - 5);

    const result = await t.query(internal.cleanup.getExpiredChallenges, {
      name: WORKER_NAME,
      cursor: START - 5,
    });
    expect(result).toEqual({
      kind: "work",
      batch: { events: [{ id: laterId }] },
      cursor: START - 5,
    });
  });

  test("a wake-up at exactly the deadline finds work", async () => {
    const t = setup();
    // At exactly `expiresAt` the challenge is expired. A wake-up at the
    // deadline must find the row, or the loop would go idle with
    // `timeoutMs: 0` forever.
    const id = await insertChallenge(t, "now", START);

    const result = await t.query(internal.cleanup.getExpiredChallenges, {
      name: WORKER_NAME,
    });
    expect(result).toEqual({
      kind: "work",
      batch: { events: [{ id }] },
      cursor: START,
    });
  });
});

describe("deleteExpiredChallenges", () => {
  test("erases the rows of the batch and keeps the others", async () => {
    const t = setup();
    const expiredId = await insertChallenge(t, "expired", START - 1);
    const freshId = await insertChallenge(t, "fresh", START + 1);
    await seedChallenge(t, {
      email: "custom@example.com",
      purpose: CUSTOM("myApp/flow", null),
      code: "custom",
      secret: "secret",
      expiresAt: START + 1,
    });

    await t.mutation(internal.cleanup.deleteExpiredChallenges, {
      events: [{ id: expiredId }],
    });

    const remaining = await t.run((ctx) =>
      ctx.db.query("challenges").collect(),
    );
    expect(remaining.map((row) => row._id)).toContain(freshId);
    expect(remaining.map((row) => row._id)).not.toContain(expiredId);
    expect(remaining).toHaveLength(2);
  });
});

// The `start` mutations ping the loop, but they read the client IP through
// `ctx.meta.getRequestMetadata()`, which convex-test does not supply.
// TODO: enable when convex-test supports ctx.meta.
describe("the cleanup loop", () => {
  test.skip("starting a challenge erases the challenges that expired", () => {});
});
