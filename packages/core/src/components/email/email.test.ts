import { convexTest } from "convex-test";
import { describe, expect, test } from "vitest";
import { register as registerRateLimiter } from "@convex-dev/rate-limiter/test";
import { api } from "./_generated/api";
import schema from "./schema";
import { normalizeEmail, validateEmailFormat } from "./validation";
import { sha256Hex } from "../../lib/crypto";

const modules = import.meta.glob("./**/*.ts");

function setup() {
  const t = convexTest(schema, modules);
  // The component mounts the rate limiter; register it with the test instance
  // so `startValidation`'s throttle has a backing component.
  registerRateLimiter(t);
  return t;
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

  test("finds the user with the same case as the stored address", async () => {
    const t = setup();
    await seedEmail(t, "user1", "Alice@Example.com", true);

    expect(
      await t.query(api.public.getUserIdByEmail, {
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
      expect(await t.query(api.public.getUserIdByEmail, { email })).toEqual({
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
      await t.query(api.public.getUserIdByEmail, {
        email: "he\u0301le\u0300ne@example.com",
      }),
    ).toEqual({ userId: "user1", email: "H\u00e9l\u00e8ne@example.com" });
  });

  test("does not match a different address that normalizes differently", async () => {
    const t = setup();
    await seedEmail(t, "user1", "Alice@Example.com", true);

    expect(
      await t.query(api.public.getUserIdByEmail, {
        email: "alice@example.org",
      }),
    ).toBeNull();
    expect(
      await t.query(api.public.getUserIdByEmail, { email: "alic@example.com" }),
    ).toBeNull();
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

type ValidationPurposeRow =
  { kind: "addEmail" } | { kind: "setEmail" } | { kind: "passwordReset" };

/**
 * Seed a pending validation row directly, hashing the code and the secret
 * like `startValidation` would. (`startValidation` itself needs `ctx.meta`,
 * which convex-test does not supply.)
 */
async function seedValidation(
  t: ReturnType<typeof setup>,
  args: {
    email: string;
    userId: string;
    purpose: ValidationPurposeRow;
    code: string;
    secret: string;
    expiresAt?: number;
  },
) {
  await t.run(async (ctx) => {
    await ctx.db.insert("pendingValidations", {
      email: args.email,
      normalizedEmail: normalizeEmail(args.email),
      userId: args.userId,
      purpose: args.purpose,
      codeHash: await sha256Hex(args.code),
      secretHash: await sha256Hex(args.secret),
      expiresAt: args.expiresAt ?? Date.now() + 60_000,
    });
  });
}

const ADD_EMAIL: ValidationPurposeRow = { kind: "addEmail" };
const SET_EMAIL: ValidationPurposeRow = { kind: "setEmail" };

describe("completeValidation", () => {
  test("addEmail: records the address; the first email becomes primary", async () => {
    const t = setup();
    await seedValidation(t, {
      email: "alice@example.com",
      userId: "user1",
      purpose: ADD_EMAIL,
      code: "code1",
      secret: "secret1",
    });

    const result = await t.mutation(api.public.completeValidation, {
      code: "code1",
      secret: "secret1",
      purpose: "addEmail",
    });
    expect(result).toEqual({
      success: true,
      userId: "user1",
      email: "alice@example.com",
      previousPrimaryEmail: null,
    });
    // `addEmail` does not ask for primary, but the first email is always
    // primary.
    expect(await t.query(api.public.getEmails, { userId: "user1" })).toEqual([
      { email: "alice@example.com", isPrimary: true },
    ]);
  });

  test("addEmail: a later email stays secondary", async () => {
    const t = setup();
    await seedEmail(t, "user1", "alice@example.com", true);
    await seedValidation(t, {
      email: "alice@work.example",
      userId: "user1",
      purpose: ADD_EMAIL,
      code: "code1",
      secret: "secret1",
    });

    const result = await t.mutation(api.public.completeValidation, {
      code: "code1",
      secret: "secret1",
      purpose: "addEmail",
    });
    expect(result).toMatchObject({ success: true });
    const emails = await t.query(api.public.getEmails, { userId: "user1" });
    expect(emails).toContainEqual({
      email: "alice@work.example",
      isPrimary: false,
    });
    expect(emails).toContainEqual({
      email: "alice@example.com",
      isPrimary: true,
    });
  });

  test("setEmail: replaces and returns the old primary", async () => {
    const t = setup();
    await seedEmail(t, "user1", "old@example.com", true);
    await seedValidation(t, {
      email: "new@example.com",
      userId: "user1",
      purpose: SET_EMAIL,
      code: "code1",
      secret: "secret1",
    });

    const result = await t.mutation(api.public.completeValidation, {
      code: "code1",
      secret: "secret1",
      purpose: "setEmail",
    });
    expect(result).toEqual({
      success: true,
      userId: "user1",
      email: "new@example.com",
      previousPrimaryEmail: "old@example.com",
    });
    // The old primary is gone; the new address is the only primary.
    expect(await t.query(api.public.getEmails, { userId: "user1" })).toEqual([
      { email: "new@example.com", isPrimary: true },
    ]);
    expect(
      await t.query(api.public.getUserIdByEmail, {
        email: "old@example.com",
      }),
    ).toBeNull();
  });

  test("the claim is one-shot: a second completion fails", async () => {
    const t = setup();
    await seedValidation(t, {
      email: "alice@example.com",
      userId: "user1",
      purpose: ADD_EMAIL,
      code: "code1",
      secret: "secret1",
    });

    const first = await t.mutation(api.public.completeValidation, {
      code: "code1",
      secret: "secret1",
      purpose: "addEmail",
    });
    expect(first).toMatchObject({ success: true });

    const second = await t.mutation(api.public.completeValidation, {
      code: "code1",
      secret: "secret1",
      purpose: "addEmail",
    });
    expect(second).toEqual({
      success: false,
      userError: { error: "INVALID_LINK" },
    });
  });

  test("a wrong secret fails and still consumes the link", async () => {
    const t = setup();
    await seedValidation(t, {
      email: "alice@example.com",
      userId: "user1",
      purpose: ADD_EMAIL,
      code: "code1",
      secret: "secret1",
    });

    const wrong = await t.mutation(api.public.completeValidation, {
      code: "code1",
      secret: "not-the-secret",
      purpose: "addEmail",
    });
    expect(wrong).toEqual({
      success: false,
      userError: { error: "INVALID_LINK" },
    });

    // The claim consumed the row, so the right secret no longer works.
    const retry = await t.mutation(api.public.completeValidation, {
      code: "code1",
      secret: "secret1",
      purpose: "addEmail",
    });
    expect(retry).toEqual({
      success: false,
      userError: { error: "INVALID_LINK" },
    });
  });

  test("an expired link fails with INVALID_LINK", async () => {
    const t = setup();
    await seedValidation(t, {
      email: "alice@example.com",
      userId: "user1",
      purpose: ADD_EMAIL,
      code: "code1",
      secret: "secret1",
      expiresAt: Date.now() - 1000,
    });

    const result = await t.mutation(api.public.completeValidation, {
      code: "code1",
      secret: "secret1",
      purpose: "addEmail",
    });
    expect(result).toEqual({
      success: false,
      userError: { error: "INVALID_LINK" },
    });
  });

  test("a purpose mismatch fails with INVALID_LINK", async () => {
    const t = setup();
    await seedValidation(t, {
      email: "alice@example.com",
      userId: "user1",
      purpose: ADD_EMAIL,
      code: "code1",
      secret: "secret1",
    });

    const result = await t.mutation(api.public.completeValidation, {
      code: "code1",
      secret: "secret1",
      purpose: "passwordReset",
    });
    expect(result).toEqual({
      success: false,
      userError: { error: "INVALID_LINK" },
    });
  });

  test("addEmail: an address verified after the start fails with EMAIL_TAKEN", async () => {
    const t = setup();
    await seedValidation(t, {
      email: "alice@example.com",
      userId: "user1",
      purpose: ADD_EMAIL,
      code: "code1",
      secret: "secret1",
    });
    // Another user verifies the address while the link is in flight.
    await seedEmail(t, "user2", "alice@example.com", true);

    const result = await t.mutation(api.public.completeValidation, {
      code: "code1",
      secret: "secret1",
      purpose: "addEmail",
    });
    expect(result).toEqual({
      success: false,
      userError: { error: "EMAIL_TAKEN" },
    });
    // The address still belongs to the user who verified it first.
    expect(
      await t.query(api.public.getUserIdByEmail, {
        email: "alice@example.com",
      }),
    ).toEqual({ userId: "user2", email: "alice@example.com" });
  });

  test("completing a validation deletes sibling validations for the email", async () => {
    const t = setup();
    // Two sign-ups race for one address; the first completion wins.
    await seedValidation(t, {
      email: "alice@example.com",
      userId: "user1",
      purpose: SET_EMAIL,
      code: "code1",
      secret: "secret1",
    });
    await seedValidation(t, {
      email: "alice@example.com",
      userId: "user2",
      purpose: SET_EMAIL,
      code: "code2",
      secret: "secret2",
    });

    const first = await t.mutation(api.public.completeValidation, {
      code: "code1",
      secret: "secret1",
      purpose: "setEmail",
    });
    expect(first).toMatchObject({ success: true, userId: "user1" });

    // The sibling was deleted, not left to fail with EMAIL_TAKEN.
    const remaining = await t.run(
      async (ctx) =>
        (await ctx.db.query("pendingValidations").collect()).length,
    );
    expect(remaining).toBe(0);
    const second = await t.mutation(api.public.completeValidation, {
      code: "code2",
      secret: "secret2",
      purpose: "setEmail",
    });
    expect(second).toEqual({
      success: false,
      userError: { error: "INVALID_LINK" },
    });
  });

  test("passwordReset: returns the userId and writes nothing", async () => {
    const t = setup();
    await seedEmail(t, "user1", "alice@example.com", true);
    await seedValidation(t, {
      email: "alice@example.com",
      userId: "user1",
      purpose: { kind: "passwordReset" },
      code: "code1",
      secret: "secret1",
    });

    const result = await t.mutation(api.public.completeValidation, {
      code: "code1",
      secret: "secret1",
      purpose: "passwordReset",
    });
    expect(result).toEqual({
      success: true,
      userId: "user1",
      email: "alice@example.com",
      previousPrimaryEmail: null,
    });
    // The emails table did not change.
    expect(await t.query(api.public.getEmails, { userId: "user1" })).toEqual([
      { email: "alice@example.com", isPrimary: true },
    ]);
  });

  test("passwordReset: fails when the address is no longer verified for the user", async () => {
    const t = setup();
    await seedValidation(t, {
      email: "alice@example.com",
      userId: "user1",
      purpose: { kind: "passwordReset" },
      code: "code1",
      secret: "secret1",
    });
    // The address was removed (or re-verified by another user) after the
    // flow started, so the proof is stale.

    const result = await t.mutation(api.public.completeValidation, {
      code: "code1",
      secret: "secret1",
      purpose: "passwordReset",
    });
    expect(result).toEqual({
      success: false,
      userError: { error: "INVALID_LINK" },
    });
  });
});

describe("getValidationStatus", () => {
  test("reports a pending flow with its purpose and email", async () => {
    const t = setup();
    await seedValidation(t, {
      email: "alice@example.com",
      userId: "user1",
      purpose: SET_EMAIL,
      code: "code1",
      secret: "secret1",
    });

    const status = await t.query(api.public.getValidationStatus, {
      code: "code1",
      secret: "secret1",
    });
    expect(status).toEqual({
      status: "pending",
      purpose: "setEmail",
      email: "alice@example.com",
    });

    // The query does not claim the flow: completion still works.
    const result = await t.mutation(api.public.completeValidation, {
      code: "code1",
      secret: "secret1",
      purpose: "setEmail",
    });
    expect(result).toMatchObject({ success: true });
  });

  test("reports invalid for an unknown code, a wrong secret, and an expired flow", async () => {
    const t = setup();
    await seedValidation(t, {
      email: "alice@example.com",
      userId: "user1",
      purpose: ADD_EMAIL,
      code: "code1",
      secret: "secret1",
    });
    await seedValidation(t, {
      email: "bob@example.com",
      userId: "user2",
      purpose: ADD_EMAIL,
      code: "code2",
      secret: "secret2",
      expiresAt: Date.now() - 1000,
    });

    expect(
      await t.query(api.public.getValidationStatus, {
        code: "unknown",
        secret: "secret1",
      }),
    ).toEqual({ status: "invalid" });
    expect(
      await t.query(api.public.getValidationStatus, {
        code: "code1",
        secret: "wrong",
      }),
    ).toEqual({ status: "invalid" });
    expect(
      await t.query(api.public.getValidationStatus, {
        code: "code2",
        secret: "secret2",
      }),
    ).toEqual({ status: "invalid" });
  });
});

describe("the pending validation address", () => {
  test("keeps both forms of the address in the row", async () => {
    const t = setup();
    await seedValidation(t, {
      email: "Alice@Example.com",
      userId: "user1",
      purpose: ADD_EMAIL,
      code: "code1",
      secret: "secret1",
    });

    const rows = await t.run((ctx) =>
      ctx.db.query("pendingValidations").collect(),
    );
    expect(rows).toHaveLength(1);
    expect(rows[0].email).toBe("Alice@Example.com");
    expect(rows[0].normalizedEmail).toBe("alice@example.com");
  });

  test("getValidationStatus reports the case that the user gave", async () => {
    const t = setup();
    await seedValidation(t, {
      email: "Alice@Example.com",
      userId: "user1",
      purpose: ADD_EMAIL,
      code: "code1",
      secret: "secret1",
    });

    expect(
      await t.query(api.public.getValidationStatus, {
        code: "code1",
        secret: "secret1",
      }),
    ).toEqual({
      status: "pending",
      purpose: "addEmail",
      email: "Alice@Example.com",
    });
  });

  test("addEmail: completion records the case that the user gave", async () => {
    const t = setup();
    await seedValidation(t, {
      email: "Alice@Example.com",
      userId: "user1",
      purpose: ADD_EMAIL,
      code: "code1",
      secret: "secret1",
    });

    const result = await t.mutation(api.public.completeValidation, {
      code: "code1",
      secret: "secret1",
      purpose: "addEmail",
    });
    expect(result).toMatchObject({
      success: true,
      email: "Alice@Example.com",
    });
    expect(await t.query(api.public.getEmails, { userId: "user1" })).toEqual([
      { email: "Alice@Example.com", isPrimary: true },
    ]);
    // The recorded row carries both forms, so a lookup in any case finds it.
    expect(
      await t.query(api.public.getUserIdByEmail, {
        email: "ALICE@EXAMPLE.COM",
      }),
    ).toEqual({ userId: "user1", email: "Alice@Example.com" });
  });

  test("addEmail: an address verified in another case fails with EMAIL_TAKEN", async () => {
    const t = setup();
    await seedValidation(t, {
      email: "Alice@Example.com",
      userId: "user1",
      purpose: ADD_EMAIL,
      code: "code1",
      secret: "secret1",
    });
    // Another user verifies the same address, written differently.
    await seedEmail(t, "user2", "alice@EXAMPLE.com", true);

    expect(
      await t.mutation(api.public.completeValidation, {
        code: "code1",
        secret: "secret1",
        purpose: "addEmail",
      }),
    ).toEqual({ success: false, userError: { error: "EMAIL_TAKEN" } });
  });

  test("passwordReset: matches a verified address written in another case", async () => {
    const t = setup();
    await seedEmail(t, "user1", "Alice@Example.com", true);
    await seedValidation(t, {
      // The user typed the address differently when starting the reset.
      email: "ALICE@example.com",
      userId: "user1",
      purpose: { kind: "passwordReset" },
      code: "code1",
      secret: "secret1",
    });

    expect(
      await t.mutation(api.public.completeValidation, {
        code: "code1",
        secret: "secret1",
        purpose: "passwordReset",
      }),
    ).toEqual({
      success: true,
      userId: "user1",
      email: "ALICE@example.com",
      previousPrimaryEmail: null,
    });
  });

  test("completion deletes siblings that use another case of the address", async () => {
    const t = setup();
    await seedValidation(t, {
      email: "Alice@Example.com",
      userId: "user1",
      purpose: SET_EMAIL,
      code: "code1",
      secret: "secret1",
    });
    await seedValidation(t, {
      email: "alice@EXAMPLE.com",
      userId: "user2",
      purpose: SET_EMAIL,
      code: "code2",
      secret: "secret2",
    });

    expect(
      await t.mutation(api.public.completeValidation, {
        code: "code1",
        secret: "secret1",
        purpose: "setEmail",
      }),
    ).toMatchObject({ success: true, userId: "user1" });

    const remaining = await t.run(
      async (ctx) =>
        (await ctx.db.query("pendingValidations").collect()).length,
    );
    expect(remaining).toBe(0);
  });
});

describe("deleteUser with validations", () => {
  test("removes the user's pending validations", async () => {
    const t = setup();
    await seedValidation(t, {
      email: "alice@example.com",
      userId: "user1",
      purpose: ADD_EMAIL,
      code: "code1",
      secret: "secret1",
    });
    await seedValidation(t, {
      email: "bob@example.com",
      userId: "user2",
      purpose: ADD_EMAIL,
      code: "code2",
      secret: "secret2",
    });

    await t.mutation(api.public.deleteUser, { userId: "user1" });

    const remaining = await t.run(async (ctx) =>
      (await ctx.db.query("pendingValidations").collect()).map(
        (row) => row.userId,
      ),
    );
    expect(remaining).toEqual(["user2"]);
  });
});

// `startValidation` and `checkStartValidation` read the client IP through
// `ctx.meta.getRequestMetadata()`, which convex-test does not supply, so
// every path that reaches them throws in tests.
// TODO: enable when convex-test supports ctx.meta.
describe("startValidation", () => {
  test.skip("sends a link and returns the secret (addEmail)", () => {});
  test.skip("resolves the user by email (passwordReset)", () => {});
  test.skip("rejects a malformed address with INVALID_EMAIL", () => {});
  test.skip("rejects a taken address with EMAIL_TAKEN (addEmail)", () => {});
  test.skip("rejects an unknown address with EMAIL_NOT_FOUND (passwordReset)", () => {});
  test.skip("rate limits per destination email", () => {});
  test.skip("rate limits per client IP", () => {});
  test.skip("appends the code with ? or & as the URL requires", () => {});
  test.skip("records the sent email through the sender handle", () => {});
});

describe("checkStartValidation", () => {
  test.skip("reports ok before any sends", () => {});
  test.skip("reports the retry delay once the limit is consumed", () => {});
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
