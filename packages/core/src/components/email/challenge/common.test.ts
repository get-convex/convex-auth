// The behavior that every challenge kind shares: the one-shot claim, the
// collapsed INVALID_LINK checks, the status query, the case of the address,
// and the cleanup when a user is deleted. `custom` is the vehicle
// unless a test needs another kind.

import { describe, expect, test } from "vitest";
import { convexTest } from "convex-test";
import { register as registerRateLimiter } from "@convex-dev/rate-limiter/test";
import { api } from "../_generated/api.ts";
import schema from "../schema.ts";
import {
  seedChallenge,
  ADD_EMAIL,
  CUSTOM,
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

const PURPOSE = "myApp/flow";
const CLAIM = { purpose: PURPOSE, userId: "user1" };

describe("the one-shot claim", () => {
  test("a second completion fails", async () => {
    const t = setup();
    await seedChallenge(t, {
      email: "alice@example.com",
      purpose: CUSTOM(PURPOSE, "user1"),
      code: "code1",
      secret: "secret1",
    });

    const first = await t.mutation(api.challenge.custom.complete, {
      code: "code1",
      secret: "secret1",
      ...CLAIM,
    });
    expect(first).toMatchObject({ success: true });

    const second = await t.mutation(api.challenge.custom.complete, {
      code: "code1",
      secret: "secret1",
      ...CLAIM,
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
      purpose: CUSTOM(PURPOSE, "user1"),
      code: "code1",
      secret: "secret1",
    });

    const wrong = await t.mutation(api.challenge.custom.complete, {
      code: "code1",
      secret: "not-the-secret",
      ...CLAIM,
    });
    expect(wrong).toEqual({
      success: false,
      userError: { error: "INVALID_LINK" },
    });

    // The claim consumed the row, so the right secret no longer works.
    const retry = await t.mutation(api.challenge.custom.complete, {
      code: "code1",
      secret: "secret1",
      ...CLAIM,
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
      purpose: CUSTOM(PURPOSE, "user1"),
      code: "code1",
      secret: "secret1",
      expiresAt: Date.now() - 1000,
    });

    const result = await t.mutation(api.challenge.custom.complete, {
      code: "code1",
      secret: "secret1",
      ...CLAIM,
    });
    expect(result).toEqual({
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
      purpose: CUSTOM(PURPOSE, "user1"),
      code: "code1",
      secret: "secret1",
    });

    const status = await t.query(api.challenge.custom.getStatus, {
      code: "code1",
      secret: "secret1",
      ...CLAIM,
    });
    expect(status).toEqual({ status: "pending", email: "alice@example.com" });

    // The query does not claim the flow: completion still works.
    const result = await t.mutation(api.challenge.custom.complete, {
      code: "code1",
      secret: "secret1",
      ...CLAIM,
    });
    expect(result).toMatchObject({ success: true });
  });

  test("reports invalid for an unknown code, a wrong secret, and an expired flow", async () => {
    const t = setup();
    await seedChallenge(t, {
      email: "alice@example.com",
      purpose: CUSTOM(PURPOSE, "user1"),
      code: "code1",
      secret: "secret1",
    });
    await seedChallenge(t, {
      email: "bob@example.com",
      purpose: CUSTOM(PURPOSE, "user1"),
      code: "code2",
      secret: "secret2",
      expiresAt: Date.now() - 1000,
    });

    expect(
      await t.query(api.challenge.custom.getStatus, {
        code: "unknown",
        secret: "secret1",
        ...CLAIM,
      }),
    ).toEqual({ status: "invalid" });
    expect(
      await t.query(api.challenge.custom.getStatus, {
        code: "code1",
        secret: "wrong",
        ...CLAIM,
      }),
    ).toEqual({ status: "invalid" });
    expect(
      await t.query(api.challenge.custom.getStatus, {
        code: "code2",
        secret: "secret2",
        ...CLAIM,
      }),
    ).toEqual({ status: "invalid" });
  });
});

describe("the kind of a challenge", () => {
  test("a challenge of another kind fails with INVALID_LINK and burns the link", async () => {
    const t = setup();
    await seedChallenge(t, {
      email: "alice@example.com",
      purpose: ADD_EMAIL("user1"),
      code: "code1",
      secret: "secret1",
    });

    // The landing page called the wrong kind: an application bug.
    const wrongKind = await t.mutation(api.challenge.custom.complete, {
      code: "code1",
      secret: "secret1",
      purpose: "addEmail",
      userId: "user1",
    });
    expect(wrongKind).toEqual({
      success: false,
      userError: { error: "INVALID_LINK" },
    });
    // The link is burned out of safety, so the right kind no longer works.
    const rightKind = await t.mutation(api.challenge.addEmail.complete, {
      code: "code1",
      secret: "secret1",
      userId: "user1",
    });
    expect(rightKind).toEqual({
      success: false,
      userError: { error: "INVALID_LINK" },
    });
  });

  test("getStatus of another kind reports invalid and keeps the row", async () => {
    const t = setup();
    await seedChallenge(t, {
      email: "alice@example.com",
      purpose: CUSTOM(PURPOSE, "user1"),
      code: "code1",
      secret: "secret1",
    });

    expect(
      await t.query(api.challenge.addEmail.getStatus, {
        code: "code1",
        secret: "secret1",
        userId: "user1",
      }),
    ).toEqual({ status: "invalid" });
    expect(
      await t.query(api.challenge.custom.getStatus, {
        code: "code1",
        secret: "secret1",
        ...CLAIM,
      }),
    ).toEqual({ status: "pending", email: "alice@example.com" });
  });
});

describe("the pending challenge address", () => {
  test("keeps the case that the user gave in the row", async () => {
    const t = setup();
    await seedChallenge(t, {
      email: "Alice@Example.com",
      purpose: CUSTOM(PURPOSE, "user1"),
      code: "code1",
      secret: "secret1",
    });

    const rows = await t.run((ctx) => ctx.db.query("challenges").collect());
    expect(rows).toHaveLength(1);
    expect(rows[0].email).toBe("Alice@Example.com");
  });

  test("getStatus and complete report the case that the user gave", async () => {
    const t = setup();
    await seedChallenge(t, {
      email: "Alice@Example.com",
      purpose: CUSTOM(PURPOSE, "user1"),
      code: "code1",
      secret: "secret1",
    });

    expect(
      await t.query(api.challenge.custom.getStatus, {
        code: "code1",
        secret: "secret1",
        ...CLAIM,
      }),
    ).toEqual({ status: "pending", email: "Alice@Example.com" });
    expect(
      await t.mutation(api.challenge.custom.complete, {
        code: "code1",
        secret: "secret1",
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
      code: "code1",
      secret: "secret1",
    });
    await seedChallenge(t, {
      email: "bob@example.com",
      purpose: CUSTOM(PURPOSE, "user2"),
      code: "code2",
      secret: "secret2",
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
