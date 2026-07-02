import { convexTest } from "convex-test";
import { describe, expect, test } from "vitest";
import { register as registerRateLimiter } from "@convex-dev/rate-limiter/test";
import { api } from "./_generated/api.js";
import schema from "./schema.js";

const modules = import.meta.glob("./**/*.ts");

const PASSWORD = "correct horse battery staple"; // 28 chars, valid

function setup() {
  const t = convexTest(schema, modules);
  // The component mounts the rate limiter; register it with the test instance
  // so `verifyPassword`'s throttle has a backing component.
  registerRateLimiter(t);
  return t;
}

describe("setPassword + verifyPassword", () => {
  test("verifies the correct password after setting it", async () => {
    const t = setup();
    await t.mutation(api.public.setPassword, {
      userId: "alice",
      password: PASSWORD,
    });
    const ok = await t.mutation(api.public.verifyPassword, {
      userId: "alice",
      password: PASSWORD,
    });
    expect(ok).toBe(true);
  });

  test("rejects a wrong password", async () => {
    const t = setup();
    await t.mutation(api.public.setPassword, {
      userId: "alice",
      password: PASSWORD,
    });
    const ok = await t.mutation(api.public.verifyPassword, {
      userId: "alice",
      password: "wrong horse battery staple",
    });
    expect(ok).toBe(false);
  });

  test("returns false for an unknown user id", async () => {
    const t = setup();
    const ok = await t.mutation(api.public.verifyPassword, {
      userId: "nobody",
      password: PASSWORD,
    });
    expect(ok).toBe(false);
  });

  test("upserts: setting a new password replaces the old one", async () => {
    const t = setup();
    await t.mutation(api.public.setPassword, {
      userId: "alice",
      password: PASSWORD,
    });
    const newPassword = "a whole new password here";
    await t.mutation(api.public.setPassword, {
      userId: "alice",
      password: newPassword,
    });

    // Only one row exists for the user.
    const count = await t.run(
      async (ctx) => (await ctx.db.query("passwords").collect()).length,
    );
    expect(count).toBe(1);

    expect(
      await t.mutation(api.public.verifyPassword, {
        userId: "alice",
        password: newPassword,
      }),
    ).toBe(true);
    expect(
      await t.mutation(api.public.verifyPassword, {
        userId: "alice",
        password: PASSWORD,
      }),
    ).toBe(false);
  });
});

describe("password validation (setPassword only)", () => {
  test("rejects a too-short password", async () => {
    const t = setup();
    await expect(
      t.mutation(api.public.setPassword, { userId: "alice", password: "short" }),
    ).rejects.toThrow(/between 10 and 100/i);
  });

  test("rejects a password with leading whitespace", async () => {
    const t = setup();
    await expect(
      t.mutation(api.public.setPassword, {
        userId: "alice",
        password: " leadingspace123",
      }),
    ).rejects.toThrow(/whitespace/i);
  });
});

describe("Unicode normalization", () => {
  test("verifies across differing normalization forms", async () => {
    const t = setup();
    // "café..." spelled two ways: composed é (U+00E9) vs decomposed
    // e + combining acute (U+0301). Padded to satisfy the length requirement.
    const composed = "caf\u00e9 password test";
    const decomposed = "cafe\u0301 password test";
    expect(composed).not.toBe(decomposed);
    expect(composed.normalize("NFC")).toBe(decomposed.normalize("NFC"));

    await t.mutation(api.public.setPassword, {
      userId: "alice",
      password: composed,
    });
    const ok = await t.mutation(api.public.verifyPassword, {
      userId: "alice",
      password: decomposed,
    });
    expect(ok).toBe(true);
  });
});

describe("rate limiting (verifyPassword only)", () => {
  test("throws once the per-user bucket is exhausted", async () => {
    const t = setup();
    await t.mutation(api.public.setPassword, {
      userId: "alice",
      password: PASSWORD,
    });

    // Capacity is 5; the first five attempts (wrong password) are allowed, the
    // sixth within the same window is rejected by the limiter.
    for (let i = 0; i < 5; i++) {
      await t.mutation(api.public.verifyPassword, {
        userId: "alice",
        password: "wrong horse battery staple",
      });
    }
    await expect(
      t.mutation(api.public.verifyPassword, {
        userId: "alice",
        password: PASSWORD,
      }),
    ).rejects.toThrow();
  });
});
