import { convexTest } from "convex-test";
import { describe, expect, test } from "vitest";
import { api } from "./_generated/api";
import schema from "./schema";
import { normalizeEmail, validateEmailFormat } from "./validation";

const modules = import.meta.glob("./**/*.ts");

function setup() {
  return convexTest(schema, modules);
}

/** Seed a verified email row directly; the validation flow arrives later. */
async function seedEmail(
  t: ReturnType<typeof setup>,
  userId: string,
  email: string,
  isPrimary: boolean,
) {
  await t.run(async (ctx) => {
    await ctx.db.insert("verifiedEmails", {
      email,
      normalizedEmail: normalizeEmail(email),
      userId,
      isPrimary,
    });
  });
}

describe("getEmails", () => {
  test("returns an empty array for a user with no emails", async () => {
    const t = setup();
    expect(await t.query(api.public.getEmails, { userId: "user1" })).toEqual(
      [],
    );
  });

  test("returns the user's emails with the primary flag", async () => {
    const t = setup();
    await seedEmail(t, "user1", "alice@example.com", true);
    await seedEmail(t, "user1", "alice@work.example", false);
    await seedEmail(t, "user2", "bob@example.com", true);

    const emails = await t.query(api.public.getEmails, { userId: "user1" });
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
      await t.query(api.public.getUserIdByEmail, {
        email: "nobody@example.com",
      }),
    ).toBeNull();
  });

  test("finds the user and ignores case and normalization form", async () => {
    const t = setup();
    await seedEmail(t, "user1", "Alice@Example.com", true);

    expect(
      await t.query(api.public.getUserIdByEmail, {
        email: "Alice@Example.com",
      }),
    ).toBe("user1");
    expect(
      await t.query(api.public.getUserIdByEmail, {
        email: "ALICE@example.COM",
      }),
    ).toBe("user1");
  });
});

describe("the stored email address", () => {
  test("keeps the case that the user gave", async () => {
    const t = setup();
    await seedEmail(t, "user1", "Alice@Example.com", true);

    expect(await t.query(api.public.getEmails, { userId: "user1" })).toEqual([
      { email: "Alice@Example.com", isPrimary: true },
    ]);
  });
});

describe("deleteUser", () => {
  test("removes all the user's emails and leaves other users alone", async () => {
    const t = setup();
    await seedEmail(t, "user1", "alice@example.com", true);
    await seedEmail(t, "user1", "alice@work.example", false);
    await seedEmail(t, "user2", "bob@example.com", true);

    await t.mutation(api.public.deleteUser, { userId: "user1" });

    expect(await t.query(api.public.getEmails, { userId: "user1" })).toEqual(
      [],
    );
    expect(
      await t.query(api.public.getUserIdByEmail, {
        email: "alice@example.com",
      }),
    ).toBeNull();
    expect(await t.query(api.public.getEmails, { userId: "user2" })).toEqual([
      { email: "bob@example.com", isPrimary: true },
    ]);
  });

  test("is idempotent for a user with no data", async () => {
    const t = setup();
    await expect(
      t.mutation(api.public.deleteUser, { userId: "user1" }),
    ).resolves.toBeNull();
  });
});

describe("validateEmailFormat", () => {
  test("accepts a plain address", () => {
    expect(validateEmailFormat("alice@example.com")).toBeNull();
  });

  test.each([
    ["no at sign", "alice.example.com"],
    ["empty local part", "@example.com"],
    ["no domain dot", "alice@example"],
    ["whitespace", "alice @example.com"],
    ["two at signs", "a@b@example.com"],
    ["too long", "a".repeat(250) + "@example.com"],
  ])("rejects %s", (_name, email) => {
    expect(validateEmailFormat(email)).toEqual({ error: "INVALID_EMAIL" });
  });
});

describe("normalizeEmail", () => {
  test("lowercases and applies NFC", () => {
    expect(normalizeEmail("Alice@Example.COM")).toBe("alice@example.com");
    // "e" + combining acute accent (U+0301) normalizes to the composed form.
    expect(normalizeEmail("he\u0301lene@example.com")).toBe(
      "h\u00e9lene@example.com",
    );
  });
});
