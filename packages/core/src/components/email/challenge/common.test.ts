// The behavior that every challenge kind shares: the one-shot claim, the
// claim failures, the case of the address, and the cleanup when a user is
// deleted. `custom` is the vehicle unless a test needs another kind.

import { describe, expect, test } from "vitest";
import { api } from "../_generated/api.ts";
import {
  seedChallenge,
  ADD_EMAIL,
  CUSTOM,
  setup,
} from "../../emailTestSetup.ts";

const PURPOSE = "myApp/flow";
const CLAIM = { purpose: PURPOSE, userId: "user1" };

async function challengeCount(t: ReturnType<typeof setup>): Promise<number> {
  return (await t.run((ctx) => ctx.db.query("challenges").collect())).length;
}

describe("the one-shot claim", () => {
  test("a second completion fails", async () => {
    const t = setup();
    await seedChallenge(t, {
      email: "alice@example.com",
      purpose: CUSTOM(PURPOSE, "user1"),
      emailCode: "code1",
      browserSecret: "secret1",
    });

    const first = await t.mutation(api.challenge.custom.complete, {
      emailCode: "code1",
      browserSecret: "secret1",
      ...CLAIM,
    });
    expect(first).toMatchObject({ success: true });

    const second = await t.mutation(api.challenge.custom.complete, {
      emailCode: "code1",
      browserSecret: "secret1",
      ...CLAIM,
    });
    expect(second).toEqual({
      success: false,
      userError: { error: "INVALID_CHALLENGE" },
    });
  });

  test("a successful claim deletes the row", async () => {
    const t = setup();
    await seedChallenge(t, {
      email: "alice@example.com",
      purpose: CUSTOM(PURPOSE, "user1"),
      emailCode: "code1",
      browserSecret: "secret1",
    });

    await t.mutation(api.challenge.custom.complete, {
      emailCode: "code1",
      browserSecret: "secret1",
      ...CLAIM,
    });
    expect(await challengeCount(t)).toBe(0);
  });

  test("a wrong code with the right secret fails with INCORRECT_CODE and keeps the row", async () => {
    const t = setup();
    await seedChallenge(t, {
      email: "alice@example.com",
      purpose: CUSTOM(PURPOSE, "user1"),
      emailCode: "code1",
      browserSecret: "secret1",
    });

    const wrong = await t.mutation(api.challenge.custom.complete, {
      emailCode: "not-the-code",
      browserSecret: "secret1",
      ...CLAIM,
    });
    expect(wrong).toEqual({
      success: false,
      userError: { error: "INCORRECT_CODE" },
    });
    expect(await challengeCount(t)).toBe(1);

    // The right code still works.
    const retry = await t.mutation(api.challenge.custom.complete, {
      emailCode: "code1",
      browserSecret: "secret1",
      ...CLAIM,
    });
    expect(retry).toMatchObject({ success: true });
  });

  test("an unknown or empty secret fails with INVALID_CHALLENGE and keeps the row", async () => {
    const t = setup();
    await seedChallenge(t, {
      email: "alice@example.com",
      purpose: CUSTOM(PURPOSE, "user1"),
      emailCode: "code1",
      browserSecret: "secret1",
    });

    for (const browserSecret of ["not-the-secret", ""]) {
      expect(
        await t.mutation(api.challenge.custom.complete, {
          emailCode: "code1",
          browserSecret,
          ...CLAIM,
        }),
      ).toEqual({ success: false, userError: { error: "INVALID_CHALLENGE" } });
    }
    // A person with only the link cannot burn the challenge.
    expect(await challengeCount(t)).toBe(1);
  });

  test("an expired link fails with INVALID_CHALLENGE and keeps the row", async () => {
    const t = setup();
    await seedChallenge(t, {
      email: "alice@example.com",
      purpose: CUSTOM(PURPOSE, "user1"),
      emailCode: "code1",
      browserSecret: "secret1",
      expiresAt: Date.now() - 1000,
    });

    const result = await t.mutation(api.challenge.custom.complete, {
      emailCode: "code1",
      browserSecret: "secret1",
      ...CLAIM,
    });
    expect(result).toEqual({
      success: false,
      userError: { error: "INVALID_CHALLENGE" },
    });
    expect(await challengeCount(t)).toBe(1);
  });
});

describe("the kind of a challenge", () => {
  test("a challenge of another kind throws and keeps the row", async () => {
    const t = setup();
    await seedChallenge(t, {
      email: "alice@example.com",
      purpose: ADD_EMAIL("user1"),
      emailCode: "code1",
      browserSecret: "secret1",
    });

    // The landing page called the wrong kind: an application bug.
    await expect(
      t.mutation(api.challenge.custom.complete, {
        emailCode: "code1",
        browserSecret: "secret1",
        purpose: "addEmail",
        userId: "user1",
      }),
    ).rejects.toThrow(/"addEmail".*"custom"/);
    expect(await challengeCount(t)).toBe(1);
    // The right kind still works.
    const rightKind = await t.mutation(api.challenge.addEmail.complete, {
      emailCode: "code1",
      browserSecret: "secret1",
      userId: "user1",
    });
    expect(rightKind).toMatchObject({ success: true });
  });
});

describe("the pending challenge address", () => {
  test("keeps the case that the user gave in the row", async () => {
    const t = setup();
    await seedChallenge(t, {
      email: "Alice@Example.com",
      purpose: CUSTOM(PURPOSE, "user1"),
      emailCode: "code1",
      browserSecret: "secret1",
    });

    const rows = await t.run((ctx) => ctx.db.query("challenges").collect());
    expect(rows).toHaveLength(1);
    expect(rows[0].email).toBe("Alice@Example.com");
  });

  test("complete reports the case that the user gave", async () => {
    const t = setup();
    await seedChallenge(t, {
      email: "Alice@Example.com",
      purpose: CUSTOM(PURPOSE, "user1"),
      emailCode: "code1",
      browserSecret: "secret1",
    });

    expect(
      await t.mutation(api.challenge.custom.complete, {
        emailCode: "code1",
        browserSecret: "secret1",
        ...CLAIM,
      }),
    ).toMatchObject({ success: true, email: "Alice@Example.com" });
  });
});

describe("deleteUser with challenges", () => {
  test("removes the user's pending challenges", async () => {
    const t = setup();
    await seedChallenge(t, {
      email: "alice@example.com",
      purpose: CUSTOM(PURPOSE, "user1"),
      emailCode: "code1",
      browserSecret: "secret1",
    });
    await seedChallenge(t, {
      email: "bob@example.com",
      purpose: CUSTOM(PURPOSE, "user2"),
      emailCode: "code2",
      browserSecret: "secret2",
    });

    await t.mutation(api.verifiedEmails.deleteUser, { userId: "user1" });

    const remaining = await t.run(async (ctx) =>
      (await ctx.db.query("challenges").collect()).map(
        (row) => row.purpose.userId,
      ),
    );
    expect(remaining).toEqual(["user2"]);
  });
});
