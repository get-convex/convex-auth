import { describe, expect, test } from "vitest";
import { convexTest } from "convex-test";
import { register as registerRateLimiter } from "@convex-dev/rate-limiter/test";
import { api } from "../_generated/api.ts";
import schema from "../schema.ts";
import {
  seedEmail,
  seedChallenge,
  ADD_EMAIL,
  CUSTOM,
  modulesFromSubdir,
} from "../testSetup.ts";
import { formatDuration } from "../helpers.ts";

const modules = modulesFromSubdir(import.meta.glob("../**/*.ts"), "challenge");

function setup() {
  const t = convexTest(schema, modules);
  registerRateLimiter(t);
  return t;
}

const PURPOSE = "myApp/reauthenticate";

describe("challenge.custom.complete", () => {
  test("returns the email and the caller's userId, and writes nothing", async () => {
    const t = setup();
    await seedEmail(t, "user1", "alice@example.com", true);
    await seedChallenge(t, {
      email: "alice@example.com",
      purpose: CUSTOM(PURPOSE, "user1"),
      code: "code1",
      secret: "secret1",
    });

    const result = await t.mutation(api.challenge.custom.complete, {
      code: "code1",
      secret: "secret1",
      purpose: PURPOSE,
      userId: "user1",
    });
    expect(result).toEqual({
      success: true,
      userId: "user1",
      email: "alice@example.com",
    });
    // The emails table did not change.
    expect(
      await t.query(api.verifiedEmails.getEmails, { userId: "user1" }),
    ).toEqual([{ email: "alice@example.com", isPrimary: true }]);
  });

  test("works without a user, and echoes null", async () => {
    const t = setup();
    await seedChallenge(t, {
      email: "alice@example.com",
      purpose: CUSTOM(PURPOSE, null),
      code: "code1",
      secret: "secret1",
    });

    expect(
      await t.mutation(api.challenge.custom.complete, {
        code: "code1",
        secret: "secret1",
        purpose: PURPOSE,
        userId: null,
      }),
    ).toEqual({ success: true, userId: null, email: "alice@example.com" });
  });

  test("does not require the address to be verified", async () => {
    const t = setup();
    await seedChallenge(t, {
      email: "nobody@example.com",
      purpose: CUSTOM(PURPOSE, null),
      code: "code1",
      secret: "secret1",
    });

    expect(
      await t.mutation(api.challenge.custom.complete, {
        code: "code1",
        secret: "secret1",
        purpose: PURPOSE,
        userId: null,
      }),
    ).toMatchObject({ success: true });
    expect(
      await t.query(api.verifiedEmails.getUserIdByEmail, {
        email: "nobody@example.com",
      }),
    ).toBeNull();
  });

  test("another purpose string fails with INVALID_LINK and burns the link", async () => {
    const t = setup();
    await seedChallenge(t, {
      email: "alice@example.com",
      purpose: CUSTOM(PURPOSE, "user1"),
      code: "code1",
      secret: "secret1",
    });

    expect(
      await t.mutation(api.challenge.custom.complete, {
        code: "code1",
        secret: "secret1",
        purpose: "myApp/otherFlow",
        userId: "user1",
      }),
    ).toEqual({ success: false, userError: { error: "INVALID_LINK" } });
    expect(
      await t.mutation(api.challenge.custom.complete, {
        code: "code1",
        secret: "secret1",
        purpose: PURPOSE,
        userId: "user1",
      }),
    ).toEqual({ success: false, userError: { error: "INVALID_LINK" } });
  });

  test("another userId fails with INVALID_LINK, and null does not match a user", async () => {
    const t = setup();
    await seedChallenge(t, {
      email: "alice@example.com",
      purpose: CUSTOM(PURPOSE, "user1"),
      code: "code1",
      secret: "secret1",
    });
    await seedChallenge(t, {
      email: "alice@example.com",
      purpose: CUSTOM(PURPOSE, null),
      code: "code2",
      secret: "secret2",
    });

    expect(
      await t.mutation(api.challenge.custom.complete, {
        code: "code1",
        secret: "secret1",
        purpose: PURPOSE,
        userId: "user2",
      }),
    ).toEqual({ success: false, userError: { error: "INVALID_LINK" } });
    expect(
      await t.mutation(api.challenge.custom.complete, {
        code: "code2",
        secret: "secret2",
        purpose: PURPOSE,
        userId: "user1",
      }),
    ).toEqual({ success: false, userError: { error: "INVALID_LINK" } });
  });

  test("a built-in challenge cannot be completed as a custom one", async () => {
    const t = setup();
    await seedChallenge(t, {
      email: "alice@example.com",
      purpose: ADD_EMAIL("user1"),
      code: "code1",
      secret: "secret1",
    });

    expect(
      await t.mutation(api.challenge.custom.complete, {
        code: "code1",
        secret: "secret1",
        purpose: "addEmail",
        userId: "user1",
      }),
    ).toEqual({ success: false, userError: { error: "INVALID_LINK" } });
  });
});

describe("challenge.custom.getStatus", () => {
  test("requires the same purpose and userId, and keeps the row", async () => {
    const t = setup();
    await seedChallenge(t, {
      email: "alice@example.com",
      purpose: CUSTOM(PURPOSE, "user1"),
      code: "code1",
      secret: "secret1",
    });

    expect(
      await t.query(api.challenge.custom.getStatus, {
        code: "code1",
        secret: "secret1",
        purpose: "myApp/otherFlow",
        userId: "user1",
      }),
    ).toEqual({ status: "invalid" });
    expect(
      await t.query(api.challenge.custom.getStatus, {
        code: "code1",
        secret: "secret1",
        purpose: PURPOSE,
        userId: null,
      }),
    ).toEqual({ status: "invalid" });
    expect(
      await t.query(api.challenge.custom.getStatus, {
        code: "code1",
        secret: "secret1",
        purpose: PURPOSE,
        userId: "user1",
      }),
    ).toEqual({ status: "pending", email: "alice@example.com" });
  });
});

describe("the expiry text of the email", () => {
  test("formatDuration", () => {
    expect(formatDuration(60_000)).toBe("1 minute");
    expect(formatDuration(10 * 60_000)).toBe("10 minutes");
    expect(formatDuration(60 * 60_000)).toBe("1 hour");
    expect(formatDuration(24 * 60 * 60_000)).toBe("24 hours");
    expect(formatDuration(90 * 60_000)).toBe("90 minutes");
  });
});

// TODO: enable when convex-test supports ctx.meta (see addEmail.test.ts).
describe("challenge.custom.start", () => {
  test.skip("sends the caller's subject and intro, and returns the secret and the challengeId", () => {});
  test.skip("uses the default TTL when ttlMs is absent", () => {});
  test.skip("throws when ttlMs is outside the bounds", () => {});
  test.skip("does not check whether the address is verified", () => {});
});
