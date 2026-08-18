import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { api, internal } from "./_generated/api";
import { WORKER_NAME } from "./cleanup";
import { CHALLENGE_TTL_MS } from "./validation";
import { setup } from "../passkeyTestSetup";

const START = new Date("2026-01-01T00:00:00Z").getTime();

/**
 * Insert a registration challenge, as `startRegistration` does. The age of a
 * challenge is the age of its `_creationTime`, thus the tests set the clock to
 * `createdAt` before the insert.
 */
function insertRegistration(
  t: ReturnType<typeof setup>,
  byte: number,
  createdAt: number,
) {
  vi.setSystemTime(createdAt);
  return t.run((ctx) =>
    ctx.db.insert("challenges", {
      // The `challenges` rows are a union, so the tests write a full row.
      kind: "registration" as const,
      challenge: new Uint8Array(32).fill(byte).buffer,
    }),
  );
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

  test("returns only the challenges that are expired", async () => {
    const t = setup();
    const expiredId = await insertRegistration(
      t,
      1,
      START - CHALLENGE_TTL_MS - 1,
    );
    // One millisecond before the TTL the challenge is still usable.
    await insertRegistration(t, 2, START - CHALLENGE_TTL_MS + 1);
    await insertRegistration(t, 3, START);

    vi.setSystemTime(START);
    const result = await t.query(internal.cleanup.getExpiredChallenges, {
      name: WORKER_NAME,
    });
    expect(result).toEqual({ kind: "work", batch: { ids: [expiredId] } });
  });

  test("goes idle until just after the oldest challenge expires", async () => {
    const t = setup();
    await insertRegistration(t, 1, START - 1000);
    await insertRegistration(t, 2, START);

    vi.setSystemTime(START);
    const result = await t.query(internal.cleanup.getExpiredChallenges, {
      name: WORKER_NAME,
    });
    expect(result).toEqual({
      kind: "idle",
      timeoutMs: CHALLENGE_TTL_MS - 1000,
    });
  });

  test("a wake-up at exactly the TTL boundary finds work", async () => {
    const t = setup();
    // A challenge at exactly the TTL is expired. A wake-up at the deadline
    // must find the row, or the loop would go idle with `timeoutMs: 0`
    // forever.
    const challengeId = await insertRegistration(
      t,
      1,
      START - CHALLENGE_TTL_MS,
    );

    vi.setSystemTime(START);
    const result = await t.query(internal.cleanup.getExpiredChallenges, {
      name: WORKER_NAME,
    });
    expect(result).toEqual({ kind: "work", batch: { ids: [challengeId] } });
  });
});

describe("deleteExpiredChallenges", () => {
  test("erases the rows of the batch and keeps the others", async () => {
    const t = setup();
    const expiredId = await insertRegistration(
      t,
      1,
      START - CHALLENGE_TTL_MS - 1,
    );
    const freshId = await insertRegistration(t, 2, START);

    await t.mutation(internal.cleanup.deleteExpiredChallenges, {
      ids: [expiredId],
    });

    const remaining = await t.run((ctx) =>
      ctx.db.query("challenges").collect(),
    );
    expect(remaining.map((row) => row._id)).toEqual([freshId]);
  });
});

describe("the cleanup loop", () => {
  test("starting a ceremony erases the challenges that expired", async () => {
    const t = setup();
    const staleId = await insertRegistration(
      t,
      1,
      START - CHALLENGE_TTL_MS - 1,
    );

    vi.setSystemTime(START);
    await t.mutation(api.registration.startRegistration, {});
    // The loop runs in scheduled functions; let them all complete.
    await t.finishAllScheduledFunctions(() => vi.runAllTimers());

    const remaining = await t.run((ctx) =>
      ctx.db.query("challenges").collect(),
    );
    expect(remaining.map((row) => row._id)).not.toContain(staleId);
    // `runAllTimers` also moves the clock past the TTL of the challenge that
    // the ceremony made, thus the loop erases that challenge too. The tests
    // above show that an unexpired challenge stays.
    expect(remaining).toEqual([]);
  });
});
