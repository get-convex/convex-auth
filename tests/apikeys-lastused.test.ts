import { components } from "@convex/_generated/api";
import { auth } from "@convex/auth";
import schema from "@convex/schema";
import { expect, test, vi } from "vite-plus/test";

import { convexTest } from "./convex/setup";

/**
 * Regression tests for the hot-path `lastUsedAt` coarsening in `key.verify`
 * (perf/growth cluster, item 1). Bearer verification must not turn every
 * read-only request into a write on a shared, hot `ApiKey` row: `lastUsedAt` is
 * only refreshed when it is unset or older than the sampling window.
 */

async function createUser(t: any) {
  return await t.run(async (ctx: any) => {
    return await ctx.runMutation(components.auth.user.create, {
      data: { email: "lastused@example.com", emailVerificationTime: Date.now() },
    });
  });
}

test("key.verify coarsens lastUsedAt: no rewrite within the sampling window", async () => {
  vi.useFakeTimers();
  try {
    const t = convexTest(schema);
    const userId = await createUser(t);

    const { secret, id: keyId } = await t.run(async (ctx: any) => {
      return await auth.key.create(ctx, {
        data: { userId, name: "Coarsen Key", scopes: [] },
      });
    });

    // First verify stamps lastUsedAt (was unset).
    await t.run(async (ctx: any) => {
      await auth.key.verify(ctx, { secret });
    });
    const first: any = await t.run(async (ctx: any) => auth.key.get(ctx, { id: keyId }));
    expect(typeof first.lastUsedAt).toBe("number");
    const stamped = first.lastUsedAt as number;

    // Advance less than the 60s window: the second verify must NOT rewrite it.
    vi.advanceTimersByTime(30_000);
    await t.run(async (ctx: any) => {
      await auth.key.verify(ctx, { secret });
    });
    const second: any = await t.run(async (ctx: any) => auth.key.get(ctx, { id: keyId }));
    expect(second.lastUsedAt).toBe(stamped);

    // Advance past the window: the third verify refreshes it.
    vi.advanceTimersByTime(61_000);
    await t.run(async (ctx: any) => {
      await auth.key.verify(ctx, { secret });
    });
    const third: any = await t.run(async (ctx: any) => auth.key.get(ctx, { id: keyId }));
    expect(third.lastUsedAt).toBeGreaterThan(stamped);
  } finally {
    vi.useRealTimers();
  }
});

test("key.verify still enforces the rate limit and persists its state each request", async () => {
  const t = convexTest(schema);
  const userId = await createUser(t);

  // A tiny bucket: 1 request per minute. The coarsening must not weaken this.
  const { secret } = await t.run(async (ctx: any) => {
    return await auth.key.create(ctx, {
      data: {
        userId,
        name: "Throttled Key",
        scopes: [],
        rateLimit: { maxRequests: 1, windowMs: 60_000 },
      },
    });
  });

  // First verify consumes the single token.
  await t.run(async (ctx: any) => {
    await auth.key.verify(ctx, { secret });
  });

  // Second immediate verify must be rejected (state persisted despite coarsening).
  await expect(
    t.run(async (ctx: any) => {
      await auth.key.verify(ctx, { secret });
    }),
  ).rejects.toThrow();
});
