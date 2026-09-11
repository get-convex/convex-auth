import { describe, expect, test } from "vitest";
import { convexTest } from "convex-test";
import { register as registerRateLimiter } from "@convex-dev/rate-limiter/test";
import { api } from "../_generated/api.ts";
import schema from "../schema.ts";
import { rateLimiter } from "../helpers.ts";
import { modulesFromSubdir } from "../testSetup.ts";

const modules = modulesFromSubdir(import.meta.glob("../**/*.ts"), "challenge");

const IP = "203.0.113.7";

function setup() {
  const t = convexTest(schema, modules);
  registerRateLimiter(t);
  return t;
}

describe("challenge.rateLimit.checkStart", () => {
  test("reports ok before any sends, and does not consume the limits", async () => {
    const t = setup();
    const check = () =>
      t
        .withRequestMetadata({ ip: IP })
        .mutation(api.challenge.rateLimit.checkStart, {
          email: "alice@example.com",
        });
    for (let i = 0; i < 10; i++) {
      expect(await check()).toEqual({ ok: true });
    }
  });

  test("reports the retry delay once the per-address limit is consumed", async () => {
    const t = setup();
    await t.run(async (ctx) => {
      await rateLimiter.limit(ctx, "startChallengePerEmail", {
        key: "alice@example.com",
        count: 5,
      });
    });
    // The key is the normalized address, so the case does not matter.
    const result = await t
      .withRequestMetadata({ ip: IP })
      .mutation(api.challenge.rateLimit.checkStart, {
        email: "Alice@Example.com",
      });
    expect(result).toMatchObject({ ok: false });
    expect(result.ok === false && result.retryAfterMs).toBeGreaterThan(0);
  });

  test("reports the retry delay once the per-IP limit is consumed", async () => {
    const t = setup();
    await t.run(async (ctx) => {
      await rateLimiter.limit(ctx, "startChallengePerIp", {
        key: IP,
        count: 20,
      });
    });
    const limited = await t
      .withRequestMetadata({ ip: IP })
      .mutation(api.challenge.rateLimit.checkStart, {
        email: "someone.else@example.com",
      });
    expect(limited).toMatchObject({ ok: false });
    const otherIp = await t
      .withRequestMetadata({ ip: "203.0.113.8" })
      .mutation(api.challenge.rateLimit.checkStart, {
        email: "someone.else@example.com",
      });
    expect(otherIp).toEqual({ ok: true });
  });

  test("throws when the request has no client IP", async () => {
    const t = setup();
    await expect(
      t.mutation(api.challenge.rateLimit.checkStart, {
        email: "alice@example.com",
      }),
    ).rejects.toThrow(/client IP/);
  });
});
