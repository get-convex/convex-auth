import { describe, expect, test } from "vitest";
import { convexTest } from "convex-test";
import { register as registerRateLimiter } from "@convex-dev/rate-limiter/test";
import { register as registerBatchWorker } from "@convex-dev/batch-worker/test";
import { api } from "./_generated/api.ts";
import schema from "./schema.ts";
import { seedEmail } from "./testSetup.ts";

const modules = import.meta.glob("./**/*.ts");

function setup() {
  const t = convexTest(schema, modules);
  // The component mounts the rate limiter and the batch worker; register
  // them with the test instance so `challenge.start`'s throttle and the sweep
  // loop have backing components.
  registerRateLimiter(t);
  registerBatchWorker(t);
  return t;
}

describe("getEmails", () => {
  test("returns an empty array for a user with no emails", async () => {
    const t = setup();
    expect(
      await t.query(api.verifiedEmails.getEmails, { userId: "user1" }),
    ).toEqual([]);
  });

  test("returns the user's emails", async () => {
    const t = setup();
    await seedEmail(t, "user1", "alice@example.com", true);
    await seedEmail(t, "user1", "alice@work.example", false);
    await seedEmail(t, "user2", "bob@example.com", true);

    const emails = await t.query(api.verifiedEmails.getEmails, {
      userId: "user1",
    });
    expect(emails).toHaveLength(2);
    expect(emails).toContainEqual({
      email: "alice@example.com",
      isPrimary: true,
    });
    expect(emails).toContainEqual({
      email: "alice@work.example",
      isPrimary: false,
    });
  });
});

describe("getUserIdByEmail", () => {
  test("returns null for an unknown email", async () => {
    const t = setup();
    expect(
      await t.query(api.verifiedEmails.getUserIdByEmail, {
        email: "nobody@example.com",
      }),
    ).toBeNull();
  });

  test("finds the user with the same case as the stored address", async () => {
    const t = setup();
    await seedEmail(t, "user1", "Alice@Example.com", true);

    expect(
      await t.query(api.verifiedEmails.getUserIdByEmail, {
        email: "Alice@Example.com",
      }),
    ).toEqual({ userId: "user1", email: "Alice@Example.com" });
  });

  test("finds the user with a different case, and returns the stored address", async () => {
    const t = setup();
    await seedEmail(t, "user1", "Alice@Example.com", true);

    for (const email of [
      "alice@example.com",
      "ALICE@EXAMPLE.COM",
      "aLiCe@eXaMpLe.CoM",
    ]) {
      expect(
        await t.query(api.verifiedEmails.getUserIdByEmail, { email }),
      ).toEqual({
        userId: "user1",
        email: "Alice@Example.com",
      });
    }
  });

  test("finds the user with a different Unicode normalization form", async () => {
    const t = setup();
    // The stored address uses the composed form ("é" as U+00E9).
    await seedEmail(t, "user1", "H\u00e9l\u00e8ne@example.com", true);

    // The argument uses the decomposed form ("e" + a combining accent).
    expect(
      await t.query(api.verifiedEmails.getUserIdByEmail, {
        email: "he\u0301le\u0300ne@example.com",
      }),
    ).toEqual({ userId: "user1", email: "H\u00e9l\u00e8ne@example.com" });
  });

  test("does not match a different address that normalizes differently", async () => {
    const t = setup();
    await seedEmail(t, "user1", "Alice@Example.com", true);

    expect(
      await t.query(api.verifiedEmails.getUserIdByEmail, {
        email: "alice@example.org",
      }),
    ).toBeNull();
    expect(
      await t.query(api.verifiedEmails.getUserIdByEmail, {
        email: "alic@example.com",
      }),
    ).toBeNull();
  });
});

describe("the stored email address", () => {
  test("keeps the case that the user gave", async () => {
    const t = setup();
    await seedEmail(t, "user1", "Alice@Example.com", true);

    expect(
      await t.query(api.verifiedEmails.getEmails, { userId: "user1" }),
    ).toEqual([{ email: "Alice@Example.com", isPrimary: true }]);
  });

  test("keeps both forms of the address in the row", async () => {
    const t = setup();
    await seedEmail(t, "user1", "Alice@Example.com", true);

    const rows = await t.run((ctx) => ctx.db.query("verifiedEmails").collect());
    expect(rows).toHaveLength(1);
    expect(rows[0].email).toBe("Alice@Example.com");
    expect(rows[0].normalizedEmail).toBe("alice@example.com");
  });
});

describe("deleteUser", () => {
  test("removes all the user's emails and leaves other users alone", async () => {
    const t = setup();
    await seedEmail(t, "user1", "alice@example.com", true);
    await seedEmail(t, "user1", "alice@work.example", false);
    await seedEmail(t, "user2", "bob@example.com", true);

    await t.mutation(api.verifiedEmails.deleteUser, { userId: "user1" });

    expect(
      await t.query(api.verifiedEmails.getEmails, { userId: "user1" }),
    ).toEqual([]);
    expect(
      await t.query(api.verifiedEmails.getUserIdByEmail, {
        email: "alice@example.com",
      }),
    ).toBeNull();
    expect(
      await t.query(api.verifiedEmails.getEmails, { userId: "user2" }),
    ).toEqual([{ email: "bob@example.com", isPrimary: true }]);
  });

  test("is idempotent for a user with no data", async () => {
    const t = setup();
    await expect(
      t.mutation(api.verifiedEmails.deleteUser, { userId: "user1" }),
    ).resolves.toBeNull();
  });
});
