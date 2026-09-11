// The preconditions that every `start` shares. The kinds call
// `startPreconditions` from their `check` and `start` mutations.

import { describe, expect, test } from "vitest";
import { rateLimiter } from "../helpers.ts";
import { setup } from "../../emailTestSetup.ts";
import { startPreconditions } from "./common.ts";

const IP = "203.0.113.7";

function run(
  t: ReturnType<typeof setup>,
  email: string,
  mode: "check" | "consume",
  ip: string | null = IP,
) {
  const runner = ip === null ? t : t.withRequestMetadata({ ip });
  return runner.run((ctx) => startPreconditions(ctx, email, mode));
}

describe("startPreconditions", () => {
  test("rejects an invalid address before it reads the limits", async () => {
    const t = setup();
    // No IP: reading the limits would throw.
    expect(await run(t, "not an address", "consume", null)).toMatchObject({
      error: "INVALID_EMAIL",
    });
  });

  test("check passes any number of times, and consumes nothing", async () => {
    const t = setup();
    for (let i = 0; i < 10; i++) {
      expect(await run(t, "alice@example.com", "check")).toBeNull();
    }
    expect(await run(t, "alice@example.com", "consume")).toBeNull();
  });

  test("consume takes one token per call from the per-address limit", async () => {
    const t = setup();
    for (let i = 0; i < 5; i++) {
      expect(await run(t, "alice@example.com", "consume")).toBeNull();
    }
    const limited = await run(t, "alice@example.com", "consume");
    expect(limited).toMatchObject({ error: "RATE_LIMITED" });
    expect(
      limited?.error === "RATE_LIMITED" && limited.retryAfterMs,
    ).toBeGreaterThan(0);
    // Another address from the same IP is fine.
    expect(await run(t, "bob@example.com", "consume")).toBeNull();
  });

  test("the per-address key is the normalized address", async () => {
    const t = setup();
    await t.run(async (ctx) => {
      await rateLimiter.limit(ctx, "startChallengePerEmail", {
        key: "alice@example.com",
        count: 5,
      });
    });
    expect(await run(t, "Alice@Example.com", "check")).toMatchObject({
      error: "RATE_LIMITED",
    });
  });

  test("the per-IP limit stops other addresses from the same IP only", async () => {
    const t = setup();
    await t.run(async (ctx) => {
      await rateLimiter.limit(ctx, "startChallengePerIp", {
        key: IP,
        count: 20,
      });
    });
    expect(await run(t, "someone.else@example.com", "check")).toMatchObject({
      error: "RATE_LIMITED",
    });
    expect(
      await run(t, "someone.else@example.com", "check", "203.0.113.8"),
    ).toBeNull();
  });

  test("throws when the request has no client IP", async () => {
    const t = setup();
    await expect(run(t, "alice@example.com", "check", null)).rejects.toThrow(
      /client IP/,
    );
  });
});
