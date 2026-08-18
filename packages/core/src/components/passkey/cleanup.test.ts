import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { api, internal } from "./_generated/api";
import type { Id } from "./_generated/dataModel";
import { WORKER_NAME } from "./cleanup";
import { CHALLENGE_TTL_MS } from "./validation";
import { setup } from "../passkeyTestSetup";

const START = new Date("2026-01-01T00:00:00Z").getTime();

// A handle row for a registration challenge. Unlinked (`userId: null`)
// until a completed ceremony links it to a user.
function handle(byte: number, userId: string | null = null) {
  return {
    handle: new Uint8Array(64).fill(byte).buffer,
    userId,
  };
}

/**
 * Insert a handle and a registration challenge that points at it, as
 * `startRegistration` does. The age of a challenge is the age of its
 * `_creationTime`, thus the tests set the clock to `createdAt` before the
 * insert. The handle goes in one millisecond earlier, in its own transaction,
 * so that the challenge gets `createdAt` exactly.
 */
async function insertRegistration(
  t: ReturnType<typeof setup>,
  byte: number,
  createdAt: number,
  userId: string | null = null,
): Promise<{ challengeId: Id<"challenges">; handleId: Id<"handles"> }> {
  vi.setSystemTime(createdAt - 1);
  const handleId = await t.run((ctx) =>
    ctx.db.insert("handles", handle(byte, userId)),
  );
  vi.setSystemTime(createdAt);
  const challengeId = await t.run((ctx) =>
    ctx.db.insert("challenges", {
      // The `challenges` rows are a union, so the tests write a full row.
      kind: "registration" as const,
      challenge: new Uint8Array(32).fill(byte).buffer,
      handleId,
    }),
  );
  return { challengeId, handleId };
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
    const { challengeId: expiredId } = await insertRegistration(
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
    expect(result).toEqual({
      kind: "work",
      batch: { events: [{ id: expiredId }] },
      cursor: START - CHALLENGE_TTL_MS - 1,
    });
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

  test("the cursor skips the rows that the loop already erased", async () => {
    const t = setup();
    // A row that stays below the cursor is a stale read for the loop: only a
    // tombstone can be below the cursor in production.
    await insertRegistration(t, 1, START - CHALLENGE_TTL_MS - 10);
    const { challengeId: laterId } = await insertRegistration(
      t,
      2,
      START - CHALLENGE_TTL_MS - 5,
    );

    vi.setSystemTime(START);
    const result = await t.query(internal.cleanup.getExpiredChallenges, {
      name: WORKER_NAME,
      cursor: START - CHALLENGE_TTL_MS - 5,
    });
    expect(result).toEqual({
      kind: "work",
      batch: { events: [{ id: laterId }] },
      cursor: START - CHALLENGE_TTL_MS - 5,
    });
  });

  test("a wake-up at exactly the TTL boundary finds work", async () => {
    const t = setup();
    // A challenge at exactly the TTL is expired. A wake-up at the deadline
    // must find the row, or the loop would go idle with `timeoutMs: 0`
    // forever.
    const { challengeId } = await insertRegistration(
      t,
      1,
      START - CHALLENGE_TTL_MS,
    );

    vi.setSystemTime(START);
    const result = await t.query(internal.cleanup.getExpiredChallenges, {
      name: WORKER_NAME,
    });
    expect(result).toEqual({
      kind: "work",
      batch: { events: [{ id: challengeId }] },
      cursor: START - CHALLENGE_TTL_MS,
    });
  });
});

describe("deleteExpiredChallenges", () => {
  test("erases the rows of the batch and keeps the others", async () => {
    const t = setup();
    const { challengeId: expiredId } = await insertRegistration(
      t,
      1,
      START - CHALLENGE_TTL_MS - 1,
    );
    const { challengeId: freshId } = await insertRegistration(t, 2, START);

    await t.mutation(internal.cleanup.deleteExpiredChallenges, {
      events: [{ id: expiredId }],
    });

    const remaining = await t.run((ctx) =>
      ctx.db.query("challenges").collect(),
    );
    expect(remaining.map((row) => row._id)).toEqual([freshId]);
  });

  test("erases the unlinked handle of an expired registration", async () => {
    const t = setup();
    const { challengeId, handleId } = await insertRegistration(
      t,
      1,
      START - CHALLENGE_TTL_MS - 1,
    );

    await t.mutation(internal.cleanup.deleteExpiredChallenges, {
      events: [{ id: challengeId }],
    });

    const remaining = await t.run((ctx) => ctx.db.get("handles", handleId));
    expect(remaining).toBeNull();
  });

  test("keeps a handle that a completed ceremony linked to a user", async () => {
    const t = setup();
    const { challengeId, handleId } = await insertRegistration(
      t,
      1,
      START - CHALLENGE_TTL_MS - 1,
      "user1",
    );

    await t.mutation(internal.cleanup.deleteExpiredChallenges, {
      events: [{ id: challengeId }],
    });

    const remaining = await t.run((ctx) => ctx.db.get("handles", handleId));
    expect(remaining).not.toBeNull();
  });
});

describe("the cleanup loop", () => {
  test("starting a ceremony erases the challenges that expired", async () => {
    const t = setup();
    const { challengeId: staleId } = await insertRegistration(
      t,
      1,
      START - CHALLENGE_TTL_MS - 1,
    );

    vi.setSystemTime(START);
    await t.mutation(api.registration.startRegistration, { userId: null });
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
    // The loop also erased the unlinked handles of both registrations.
    const handles = await t.run((ctx) => ctx.db.query("handles").collect());
    expect(handles).toEqual([]);
  });
});
