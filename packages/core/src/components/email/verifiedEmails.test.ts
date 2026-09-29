import { describe, expect, test } from "vitest";
import { api } from "./_generated/api.ts";
import { seedEmail, setup, verifiedEmailRow } from "../emailTestSetup.ts";

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

describe("getPrimaryEmail", () => {
  test("returns null for a user with no emails", async () => {
    const t = setup();
    expect(
      await t.query(api.verifiedEmails.getPrimaryEmail, { userId: "user1" }),
    ).toBeNull();
  });

  test("returns the primary email, not a secondary one", async () => {
    const t = setup();
    await seedEmail(t, "user1", "alice@work.example", false);
    await seedEmail(t, "user1", "Alice@Example.com", true);
    await seedEmail(t, "user2", "bob@example.com", true);

    expect(
      await t.query(api.verifiedEmails.getPrimaryEmail, { userId: "user1" }),
    ).toBe("Alice@Example.com");
  });
});

const IP = "203.0.113.7";

describe("lookupEmail", () => {
  test("returns EMAIL_NOT_FOUND for an unknown email", async () => {
    const t = setup();
    expect(
      await t
        .withRequestMetadata({ ip: IP })
        .mutation(api.verifiedEmails.lookupEmail, {
          email: "nobody@example.com",
        }),
    ).toEqual({ success: false, userError: { error: "EMAIL_NOT_FOUND" } });
  });

  test("finds the user with the same case as the stored address", async () => {
    const t = setup();
    await seedEmail(t, "user1", "Alice@Example.com", true);

    expect(
      await t
        .withRequestMetadata({ ip: IP })
        .mutation(api.verifiedEmails.lookupEmail, {
          email: "Alice@Example.com",
        }),
    ).toEqual({
      success: true,
      userId: "user1",
      storedEmail: "Alice@Example.com",
    });
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
        await t
          .withRequestMetadata({ ip: IP })
          .mutation(api.verifiedEmails.lookupEmail, { email }),
      ).toEqual({
        success: true,
        userId: "user1",
        storedEmail: "Alice@Example.com",
      });
    }
  });

  test("finds the user with a different Unicode normalization form", async () => {
    const t = setup();
    // The stored address uses the composed form ("é" as U+00E9).
    await seedEmail(t, "user1", "H\u00e9l\u00e8ne@example.com", true);

    // The argument uses the decomposed form ("e" + a combining accent).
    expect(
      await t
        .withRequestMetadata({ ip: IP })
        .mutation(api.verifiedEmails.lookupEmail, {
          email: "he\u0301le\u0300ne@example.com",
        }),
    ).toEqual({
      success: true,
      userId: "user1",
      storedEmail: "H\u00e9l\u00e8ne@example.com",
    });
  });

  test("returns the address that matched, not the primary address", async () => {
    const t = setup();
    await seedEmail(t, "user1", "alice@example.com", true);
    await seedEmail(t, "user1", "Alice@Work.example", false);

    expect(
      await t
        .withRequestMetadata({ ip: IP })
        .mutation(api.verifiedEmails.lookupEmail, {
          email: "alice@work.example",
        }),
    ).toEqual({
      success: true,
      userId: "user1",
      storedEmail: "Alice@Work.example",
    });
  });

  test("does not match a different address that normalizes differently", async () => {
    const t = setup();
    await seedEmail(t, "user1", "Alice@Example.com", true);

    for (const email of ["alice@example.org", "alic@example.com"]) {
      expect(
        await t
          .withRequestMetadata({ ip: IP })
          .mutation(api.verifiedEmails.lookupEmail, { email }),
      ).toEqual({ success: false, userError: { error: "EMAIL_NOT_FOUND" } });
    }
  });

  test("limits the lookups per IP, for found and unknown addresses", async () => {
    const t = setup();
    await seedEmail(t, "user1", "alice@example.com", true);

    // Use all the tokens of the IP. Half of the lookups find nothing: a
    // probe for unknown addresses also takes tokens.
    for (let i = 0; i < 60; i++) {
      const result = await t
        .withRequestMetadata({ ip: IP })
        .mutation(api.verifiedEmails.lookupEmail, {
          email: i % 2 === 0 ? "alice@example.com" : `nobody${i}@example.com`,
        });
      expect(result.success || result.userError.error).not.toBe("RATE_LIMITED");
    }

    // The next lookups fail with the same error for an address that exists
    // and for an unknown address. Thus a probe cannot tell them apart.
    for (const email of ["alice@example.com", "nobody@example.com"]) {
      expect(
        await t
          .withRequestMetadata({ ip: IP })
          .mutation(api.verifiedEmails.lookupEmail, { email }),
      ).toEqual({
        success: false,
        userError: { error: "RATE_LIMITED", retryAfterMs: expect.any(Number) },
      });
    }

    // Another IP has its own tokens.
    expect(
      await t
        .withRequestMetadata({ ip: "198.51.100.2" })
        .mutation(api.verifiedEmails.lookupEmail, {
          email: "alice@example.com",
        }),
    ).toEqual({
      success: true,
      userId: "user1",
      storedEmail: "alice@example.com",
    });
  });

  test("throws without a client IP", async () => {
    const t = setup();
    await expect(
      t.mutation(api.verifiedEmails.lookupEmail, {
        email: "alice@example.com",
      }),
    ).rejects.toThrow(/client IP/);
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
    expect(await verifiedEmailRow(t, "alice@example.com")).toBeNull();
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
