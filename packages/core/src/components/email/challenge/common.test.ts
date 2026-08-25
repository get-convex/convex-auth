// The behavior that every challenge kind shares: the one-shot claim, the
// collapsed INVALID_LINK checks, the status query, and the two forms of the
// address. `addEmail` is the vehicle unless a test needs another kind.

import { describe, expect, test } from "vitest";
import { convexTest } from "convex-test";
import { register as registerRateLimiter } from "@convex-dev/rate-limiter/test";
import { api } from "../_generated/api.ts";
import schema from "../schema.ts";
import {
  seedChallenge,
  ADD_EMAIL,
  SET_PRIMARY_EMAIL,
  modulesFromSubdir,
} from "../testSetup.ts";

const modules = modulesFromSubdir(import.meta.glob("../**/*.ts"), "challenge");

function setup() {
  const t = convexTest(schema, modules);
  // The component mounts the rate limiter; register it with the test instance
  // so the `start` mutations' throttle has a backing component.
  registerRateLimiter(t);
  return t;
}

describe("the one-shot claim", () => {
  test("a second completion fails", async () => {
    const t = setup();
    await seedChallenge(t, {
      email: "alice@example.com",
      userId: "user1",
      purpose: ADD_EMAIL,
      code: "code1",
      secret: "secret1",
    });

    const first = await t.mutation(api.challenge.addEmail.complete, {
      code: "code1",
      secret: "secret1",
    });
    expect(first).toMatchObject({ success: true });

    const second = await t.mutation(api.challenge.addEmail.complete, {
      code: "code1",
      secret: "secret1",
    });
    expect(second).toEqual({
      success: false,
      userError: { error: "INVALID_LINK" },
    });
  });

  test("a wrong secret fails and still consumes the link", async () => {
    const t = setup();
    await seedChallenge(t, {
      email: "alice@example.com",
      userId: "user1",
      purpose: ADD_EMAIL,
      code: "code1",
      secret: "secret1",
    });

    const wrong = await t.mutation(api.challenge.addEmail.complete, {
      code: "code1",
      secret: "not-the-secret",
    });
    expect(wrong).toEqual({
      success: false,
      userError: { error: "INVALID_LINK" },
    });

    // The claim consumed the row, so the right secret no longer works.
    const retry = await t.mutation(api.challenge.addEmail.complete, {
      code: "code1",
      secret: "secret1",
    });
    expect(retry).toEqual({
      success: false,
      userError: { error: "INVALID_LINK" },
    });
  });

  test("an expired link fails with INVALID_LINK", async () => {
    const t = setup();
    await seedChallenge(t, {
      email: "alice@example.com",
      userId: "user1",
      purpose: ADD_EMAIL,
      code: "code1",
      secret: "secret1",
      expiresAt: Date.now() - 1000,
    });

    const result = await t.mutation(api.challenge.addEmail.complete, {
      code: "code1",
      secret: "secret1",
    });
    expect(result).toEqual({
      success: false,
      userError: { error: "INVALID_LINK" },
    });
  });

  test("a challenge of another kind fails with INVALID_LINK and burns the link", async () => {
    const t = setup();
    await seedChallenge(t, {
      email: "alice@example.com",
      userId: "user1",
      purpose: ADD_EMAIL,
      code: "code1",
      secret: "secret1",
    });

    // The landing page called the wrong kind: an application bug.
    const wrongKind = await t.mutation(api.challenge.passwordReset.complete, {
      code: "code1",
      secret: "secret1",
    });
    expect(wrongKind).toEqual({
      success: false,
      userError: { error: "INVALID_LINK" },
    });
    // The link is burned out of safety, so the right kind no longer works.
    const rightKind = await t.mutation(api.challenge.addEmail.complete, {
      code: "code1",
      secret: "secret1",
    });
    expect(rightKind).toEqual({
      success: false,
      userError: { error: "INVALID_LINK" },
    });
  });
});

describe("getStatus", () => {
  test("reports a pending flow with its email, and does not claim it", async () => {
    const t = setup();
    await seedChallenge(t, {
      email: "alice@example.com",
      userId: "user1",
      purpose: SET_PRIMARY_EMAIL,
      code: "code1",
      secret: "secret1",
    });

    const status = await t.query(api.challenge.setPrimaryEmail.getStatus, {
      code: "code1",
      secret: "secret1",
    });
    expect(status).toEqual({ status: "pending", email: "alice@example.com" });

    // The query does not claim the flow: completion still works.
    const result = await t.mutation(api.challenge.setPrimaryEmail.complete, {
      code: "code1",
      secret: "secret1",
    });
    expect(result).toMatchObject({ success: true });
  });

  test("reports invalid for an unknown code, a wrong secret, and an expired flow", async () => {
    const t = setup();
    await seedChallenge(t, {
      email: "alice@example.com",
      userId: "user1",
      purpose: ADD_EMAIL,
      code: "code1",
      secret: "secret1",
    });
    await seedChallenge(t, {
      email: "bob@example.com",
      userId: "user2",
      purpose: ADD_EMAIL,
      code: "code2",
      secret: "secret2",
      expiresAt: Date.now() - 1000,
    });

    expect(
      await t.query(api.challenge.addEmail.getStatus, {
        code: "unknown",
        secret: "secret1",
      }),
    ).toEqual({ status: "invalid" });
    expect(
      await t.query(api.challenge.addEmail.getStatus, {
        code: "code1",
        secret: "wrong",
      }),
    ).toEqual({ status: "invalid" });
    expect(
      await t.query(api.challenge.addEmail.getStatus, {
        code: "code2",
        secret: "secret2",
      }),
    ).toEqual({ status: "invalid" });
  });

  test("reports invalid for a challenge of another kind, and keeps the row", async () => {
    const t = setup();
    await seedChallenge(t, {
      email: "alice@example.com",
      userId: "user1",
      purpose: ADD_EMAIL,
      code: "code1",
      secret: "secret1",
    });

    expect(
      await t.query(api.challenge.setPrimaryEmail.getStatus, {
        code: "code1",
        secret: "secret1",
      }),
    ).toEqual({ status: "invalid" });
    expect(
      await t.query(api.challenge.addEmail.getStatus, {
        code: "code1",
        secret: "secret1",
      }),
    ).toEqual({ status: "pending", email: "alice@example.com" });
  });
});

describe("concurrent challenges", () => {
  test("a challenge for the same address stays pending, then fails", async () => {
    const t = setup();
    // Two sign-ups race for one address; the first completion wins.
    await seedChallenge(t, {
      email: "alice@example.com",
      userId: "user1",
      purpose: SET_PRIMARY_EMAIL,
      code: "code1",
      secret: "secret1",
    });
    await seedChallenge(t, {
      email: "alice@example.com",
      userId: "user2",
      purpose: SET_PRIMARY_EMAIL,
      code: "code2",
      secret: "secret2",
    });

    const first = await t.mutation(api.challenge.setPrimaryEmail.complete, {
      code: "code1",
      secret: "secret1",
    });
    expect(first).toMatchObject({ success: true, userId: "user1" });

    // The other challenge is not deleted. It stays pending, and fails only
    // when the user tries to complete it.
    expect(
      await t.query(api.challenge.setPrimaryEmail.getStatus, {
        code: "code2",
        secret: "secret2",
      }),
    ).toMatchObject({ status: "pending" });
    const second = await t.mutation(api.challenge.setPrimaryEmail.complete, {
      code: "code2",
      secret: "secret2",
    });
    expect(second).toEqual({
      success: false,
      userError: { error: "EMAIL_TAKEN" },
    });
  });

  test("a challenge that uses another case of the address fails after completion", async () => {
    const t = setup();
    await seedChallenge(t, {
      email: "Alice@Example.com",
      userId: "user1",
      purpose: SET_PRIMARY_EMAIL,
      code: "code1",
      secret: "secret1",
    });
    await seedChallenge(t, {
      email: "alice@EXAMPLE.com",
      userId: "user2",
      purpose: SET_PRIMARY_EMAIL,
      code: "code2",
      secret: "secret2",
    });

    expect(
      await t.mutation(api.challenge.setPrimaryEmail.complete, {
        code: "code1",
        secret: "secret1",
      }),
    ).toMatchObject({ success: true, userId: "user1" });

    expect(
      await t.mutation(api.challenge.setPrimaryEmail.complete, {
        code: "code2",
        secret: "secret2",
      }),
    ).toEqual({ success: false, userError: { error: "EMAIL_TAKEN" } });
  });
});

describe("the pending challenge address", () => {
  test("keeps both forms of the address in the row", async () => {
    const t = setup();
    await seedChallenge(t, {
      email: "Alice@Example.com",
      userId: "user1",
      purpose: ADD_EMAIL,
      code: "code1",
      secret: "secret1",
    });

    const rows = await t.run((ctx) => ctx.db.query("challenges").collect());
    expect(rows).toHaveLength(1);
    expect(rows[0].email).toBe("Alice@Example.com");
    expect(rows[0].normalizedEmail).toBe("alice@example.com");
  });

  test("getStatus reports the case that the user gave", async () => {
    const t = setup();
    await seedChallenge(t, {
      email: "Alice@Example.com",
      userId: "user1",
      purpose: ADD_EMAIL,
      code: "code1",
      secret: "secret1",
    });

    expect(
      await t.query(api.challenge.addEmail.getStatus, {
        code: "code1",
        secret: "secret1",
      }),
    ).toEqual({ status: "pending", email: "Alice@Example.com" });
  });
});

describe("deleteUser with challenges", () => {
  test("removes the user's pending challenges", async () => {
    const t = setup();
    await seedChallenge(t, {
      email: "alice@example.com",
      userId: "user1",
      purpose: ADD_EMAIL,
      code: "code1",
      secret: "secret1",
    });
    await seedChallenge(t, {
      email: "bob@example.com",
      userId: "user2",
      purpose: ADD_EMAIL,
      code: "code2",
      secret: "secret2",
    });

    await t.mutation(api.verifiedEmails.deleteUser, { userId: "user1" });

    const remaining = await t.run(async (ctx) =>
      (await ctx.db.query("challenges").collect()).map((row) => row.userId),
    );
    expect(remaining).toEqual(["user2"]);
  });
});
