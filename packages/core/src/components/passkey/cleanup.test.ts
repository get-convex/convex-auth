import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { api, internal } from "./_generated/api";
import { WORKER_NAME } from "./cleanup";
import { CHALLENGE_TTL_MS } from "./validation";
import { setup } from "../passkeyTestSetup";

// The `challenges` rows are a union, so the tests write a full row.
function registrationChallenge(byte: number, createdAt: number) {
  return {
    kind: "registration" as const,
    challenge: new Uint8Array(32).fill(byte).buffer,
    createdAt,
  };
}

/** Insert a registration challenge, as `startRegistration` does. */
function insertRegistration(
  t: ReturnType<typeof setup>,
  byte: number,
  createdAt: number,
) {
  return t.run((ctx) =>
    ctx.db.insert("challenges", registrationChallenge(byte, createdAt)),
  );
}

beforeEach(() => {
  vi.useFakeTimers();
  // A fixed time keeps `createdAt` predictable.
  vi.setSystemTime(new Date("2026-01-01T00:00:00Z"));
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
    const now = Date.now();
    const expiredId = await insertRegistration(
      t,
      1,
      now - CHALLENGE_TTL_MS - 1,
    );
    // One millisecond before the TTL the challenge is still usable.
    await insertRegistration(t, 2, now - CHALLENGE_TTL_MS + 1);
    await insertRegistration(t, 3, now);

    const result = await t.query(internal.cleanup.getExpiredChallenges, {
      name: WORKER_NAME,
    });
    expect(result).toEqual({ kind: "work", batch: { ids: [expiredId] } });
  });

  test("goes idle until just after the oldest challenge expires", async () => {
    const t = setup();
    const now = Date.now();
    await t.run(async (ctx) => {
      await ctx.db.insert("challenges", registrationChallenge(1, now - 1000));
      await ctx.db.insert("challenges", registrationChallenge(2, now));
    });

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
    const now = Date.now();
    // A challenge at exactly the TTL is expired. A wake-up at the deadline
    // must find the row, or the loop would go idle with `timeoutMs: 0`
    // forever.
    const challengeId = await insertRegistration(t, 1, now - CHALLENGE_TTL_MS);

    const result = await t.query(internal.cleanup.getExpiredChallenges, {
      name: WORKER_NAME,
    });
    expect(result).toEqual({ kind: "work", batch: { ids: [challengeId] } });
  });
});

describe("deleteExpiredChallenges", () => {
  test("erases the rows of the batch and keeps the others", async () => {
    const t = setup();
    const now = Date.now();
    const expiredId = await insertRegistration(
      t,
      1,
      now - CHALLENGE_TTL_MS - 1,
    );
    const freshId = await insertRegistration(t, 2, now);

    await t.mutation(internal.cleanup.deleteExpiredChallenges, {
      ids: [expiredId],
    });

    const remaining = await t.run((ctx) =>
      ctx.db.query("challenges").collect(),
    );
    expect(remaining.map((row) => row._id)).toEqual([freshId]);
  });

  test("ignores a row that a ceremony consumed in the meantime", async () => {
    const t = setup();
    const now = Date.now();
    const challengeId = await insertRegistration(
      t,
      1,
      now - CHALLENGE_TTL_MS - 1,
    );
    await t.run((ctx) => ctx.db.delete("challenges", challengeId));

    await expect(
      t.mutation(internal.cleanup.deleteExpiredChallenges, {
        ids: [challengeId],
      }),
    ).resolves.toBeNull();
  });
});

describe("the cleanup loop", () => {
  test("starting a ceremony erases the challenges that expired", async () => {
    const t = setup();
    const now = Date.now();
    const staleId = await insertRegistration(t, 1, now - CHALLENGE_TTL_MS - 1);

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
