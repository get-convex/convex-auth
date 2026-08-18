import { convexTest } from "convex-test";
import { afterEach, describe, expect, test, vi } from "vitest";
import {
  consumeChallenge,
  randomChallenge,
  randomHandle,
  toArrayBuffer,
} from "./helpers";
import schema from "./schema";
import { MutationCtx } from "./_generated/server";
import { Id } from "./_generated/dataModel";

/** Insert an unlinked handle, as `startRegistration` does. */
function insertHandle(ctx: MutationCtx): Promise<Id<"handles">> {
  return ctx.db.insert("handles", { handle: randomHandle(), userId: null });
}

const modules = import.meta.glob("./**/*.ts");

const CHALLENGE_TTL_MS = 10 * 60 * 1000;

function setup() {
  return convexTest(schema, modules);
}

describe("toArrayBuffer", () => {
  test("returns the underlying buffer for a full view", () => {
    const bytes = new Uint8Array([1, 2, 3]);
    const result = toArrayBuffer(bytes);
    expect(result).toBe(bytes.buffer);
  });

  test("copies the bytes of an offset view", () => {
    const full = new Uint8Array([1, 2, 3, 4, 5]);
    const view = full.subarray(1, 4);
    const result = toArrayBuffer(view);
    expect(result).not.toBe(full.buffer);
    expect(new Uint8Array(result)).toEqual(new Uint8Array([2, 3, 4]));
    // The copy is independent from the original bytes.
    full[2] = 42;
    expect(new Uint8Array(result)).toEqual(new Uint8Array([2, 3, 4]));
  });

  test("handles zero-length input", () => {
    const view = new Uint8Array([1, 2, 3]).subarray(1, 1);
    expect(new Uint8Array(toArrayBuffer(view)).length).toBe(0);
  });
});

describe("randomChallenge", () => {
  test("returns 32 bytes", () => {
    expect(new Uint8Array(randomChallenge()).length).toBe(32);
  });

  test("returns distinct values", () => {
    const a = new Uint8Array(randomChallenge());
    const b = new Uint8Array(randomChallenge());
    expect(a).not.toEqual(b);
  });
});

describe("consumeChallenge", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  test("returns and deletes a valid challenge", async () => {
    const t = setup();
    const challenge = crypto.getRandomValues(new Uint8Array(32));
    await t.run(async (ctx) => {
      await ctx.db.insert("challenges", {
        kind: "registration",
        challenge: toArrayBuffer(challenge),
        handleId: await insertHandle(ctx),
      });
      const row = await consumeChallenge(ctx, "registration", challenge);
      expect(row).not.toBe(null);
      expect(row!.kind).toBe("registration");
      expect(await ctx.db.query("challenges").collect()).toEqual([]);
      // The challenge was not expired: its handle stays.
      expect(await ctx.db.query("handles").collect()).toHaveLength(1);
    });
  });

  test("returns null for an unknown challenge", async () => {
    const t = setup();
    await t.run(async (ctx) => {
      const row = await consumeChallenge(
        ctx,
        "registration",
        crypto.getRandomValues(new Uint8Array(32)),
      );
      expect(row).toBe(null);
    });
  });

  test("returns null on a kind mismatch and keeps the row", async () => {
    const t = setup();
    const challenge = crypto.getRandomValues(new Uint8Array(32));
    await t.run(async (ctx) => {
      await ctx.db.insert("challenges", {
        kind: "registration",
        challenge: toArrayBuffer(challenge),
        handleId: await insertHandle(ctx),
      });
      const row = await consumeChallenge(ctx, "authentication", challenge);
      expect(row).toBe(null);
      // The registration challenge survives the bogus authentication attempt.
      expect(await ctx.db.query("challenges").collect()).toHaveLength(1);
    });
  });

  test("is single-use", async () => {
    const t = setup();
    const challenge = crypto.getRandomValues(new Uint8Array(32));
    await t.run(async (ctx) => {
      await ctx.db.insert("challenges", {
        kind: "authentication",
        challenge: toArrayBuffer(challenge),
      });
      expect(await consumeChallenge(ctx, "authentication", challenge)).not.toBe(
        null,
      );
      expect(await consumeChallenge(ctx, "authentication", challenge)).toBe(
        null,
      );
    });
  });

  /**
   * Insert a handle and a registration challenge that points at it, then move
   * the clock forward by `ageMs`. The age of a challenge is the age of its
   * `_creationTime`, thus the clock is the only way to make a challenge old.
   * The handle goes in one millisecond earlier, in its own transaction, so
   * that the challenge gets the base time exactly.
   */
  async function insertAndAge(
    t: ReturnType<typeof setup>,
    challenge: Uint8Array,
    ageMs: number,
  ) {
    vi.useFakeTimers();
    vi.setSystemTime(1_700_000_000_000 - 1);
    const handleId = await t.run((ctx) => insertHandle(ctx));
    vi.setSystemTime(1_700_000_000_000);
    await t.run((ctx) =>
      ctx.db.insert("challenges", {
        kind: "registration",
        challenge: toArrayBuffer(challenge),
        handleId,
      }),
    );
    vi.setSystemTime(1_700_000_000_000 + ageMs);
  }

  test("rejects and deletes an expired challenge", async () => {
    const t = setup();
    const challenge = crypto.getRandomValues(new Uint8Array(32));
    await insertAndAge(t, challenge, CHALLENGE_TTL_MS + 1);
    await t.run(async (ctx) => {
      const row = await consumeChallenge(ctx, "registration", challenge);
      expect(row).toBe(null);
      // The expired row was deleted on the way out, together with its
      // unlinked handle.
      expect(await ctx.db.query("challenges").collect()).toEqual([]);
      expect(await ctx.db.query("handles").collect()).toEqual([]);
    });
  });

  test("rejects a challenge exactly at the TTL boundary", async () => {
    const t = setup();
    const challenge = crypto.getRandomValues(new Uint8Array(32));
    await insertAndAge(t, challenge, CHALLENGE_TTL_MS);
    // A challenge is valid for strictly less than the TTL: at exactly
    // the TTL, it is expired. This is the same boundary that the cleanup
    // loop uses.
    await t.run(async (ctx) => {
      expect(await consumeChallenge(ctx, "registration", challenge)).toBe(null);
    });
  });

  test("accepts a challenge one millisecond before the TTL boundary", async () => {
    const t = setup();
    const challenge = crypto.getRandomValues(new Uint8Array(32));
    await insertAndAge(t, challenge, CHALLENGE_TTL_MS - 1);
    await t.run(async (ctx) => {
      expect(await consumeChallenge(ctx, "registration", challenge)).not.toBe(
        null,
      );
    });
  });
});
