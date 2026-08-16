import { describe, expect, test } from "vitest";
import { convexTest } from "convex-test";
import { register as registerRateLimiter } from "@convex-dev/rate-limiter/test";
import { api } from "./_generated/api.ts";
import schema from "./schema.ts";
import { seedEmail, seedChallenge } from "./testSetup.ts";

const modules = import.meta.glob("./**/*.ts");

function setup() {
  const t = convexTest(schema, modules);
  // The component mounts the rate limiter; register it with the test instance
  // so `challenge.start`'s throttle has a backing component.
  registerRateLimiter(t);
  return t;
}

describe("challenge.complete", () => {
  test("records the address; the first email becomes primary", async () => {
    const t = setup();
    await seedChallenge(t, {
      email: "alice@example.com",
      userId: "user1",
      code: "code1",
      secret: "secret1",
    });

    const result = await t.mutation(api.challenge.complete, {
      code: "code1",
      secret: "secret1",
    });
    expect(result).toEqual({
      success: true,
      userId: "user1",
      email: "alice@example.com",
      isPrimary: true,
    });
    expect(
      await t.query(api.verifiedEmails.getEmails, { userId: "user1" }),
    ).toEqual([{ email: "alice@example.com", isPrimary: true }]);
  });

  test("a later email stays secondary", async () => {
    const t = setup();
    await seedEmail(t, "user1", "alice@example.com", true);
    await seedChallenge(t, {
      email: "alice2@example.com",
      userId: "user1",
      code: "code1",
      secret: "secret1",
    });

    const result = await t.mutation(api.challenge.complete, {
      code: "code1",
      secret: "secret1",
    });
    expect(result).toMatchObject({ success: true, isPrimary: false });
    expect(
      await t.query(api.verifiedEmails.getEmails, { userId: "user1" }),
    ).toEqual([
      { email: "alice@example.com", isPrimary: true },
      { email: "alice2@example.com", isPrimary: false },
    ]);
  });

  test("the claim is one-shot: a second completion fails", async () => {
    const t = setup();
    await seedChallenge(t, {
      email: "alice@example.com",
      userId: "user1",
      code: "code1",
      secret: "secret1",
    });

    expect(
      await t.mutation(api.challenge.complete, {
        code: "code1",
        secret: "secret1",
      }),
    ).toMatchObject({ success: true });
    expect(
      await t.mutation(api.challenge.complete, {
        code: "code1",
        secret: "secret1",
      }),
    ).toEqual({ success: false, userError: { error: "INVALID_LINK" } });
  });

  test("a wrong secret fails and still consumes the link", async () => {
    const t = setup();
    await seedChallenge(t, {
      email: "alice@example.com",
      userId: "user1",
      code: "code1",
      secret: "secret1",
    });

    expect(
      await t.mutation(api.challenge.complete, {
        code: "code1",
        secret: "wrong",
      }),
    ).toEqual({ success: false, userError: { error: "INVALID_LINK" } });
    // The row is gone: even the right secret cannot complete it now.
    expect(
      await t.mutation(api.challenge.complete, {
        code: "code1",
        secret: "secret1",
      }),
    ).toEqual({ success: false, userError: { error: "INVALID_LINK" } });
    expect(
      await t.query(api.verifiedEmails.getEmails, { userId: "user1" }),
    ).toEqual([]);
  });

  test("an expired link fails with INVALID_LINK", async () => {
    const t = setup();
    await seedChallenge(t, {
      email: "alice@example.com",
      userId: "user1",
      code: "code1",
      secret: "secret1",
      expiresAt: Date.now() - 1000,
    });

    expect(
      await t.mutation(api.challenge.complete, {
        code: "code1",
        secret: "secret1",
      }),
    ).toEqual({ success: false, userError: { error: "INVALID_LINK" } });
  });

  test("an unknown code fails with INVALID_LINK", async () => {
    const t = setup();
    expect(
      await t.mutation(api.challenge.complete, {
        code: "nope",
        secret: "secret1",
      }),
    ).toEqual({ success: false, userError: { error: "INVALID_LINK" } });
  });

  test("an address verified by another user after the start fails with EMAIL_TAKEN", async () => {
    const t = setup();
    await seedChallenge(t, {
      email: "alice@example.com",
      userId: "user1",
      code: "code1",
      secret: "secret1",
    });
    await seedEmail(t, "user2", "alice@example.com", true);

    expect(
      await t.mutation(api.challenge.complete, {
        code: "code1",
        secret: "secret1",
      }),
    ).toEqual({ success: false, userError: { error: "EMAIL_TAKEN" } });
    expect(
      await t.query(api.verifiedEmails.getEmails, { userId: "user1" }),
    ).toEqual([]);
  });
});

describe("challenge.getStatus", () => {
  test("reports a pending challenge with its email", async () => {
    const t = setup();
    await seedChallenge(t, {
      email: "alice@example.com",
      userId: "user1",
      code: "code1",
      secret: "secret1",
    });

    expect(
      await t.query(api.challenge.getStatus, {
        code: "code1",
        secret: "secret1",
      }),
    ).toEqual({ status: "pending", email: "alice@example.com" });

    // The query does not claim the challenge: completion still works.
    expect(
      await t.mutation(api.challenge.complete, {
        code: "code1",
        secret: "secret1",
      }),
    ).toMatchObject({ success: true });
  });

  test("reports invalid for an unknown code, a wrong secret, and an expired challenge", async () => {
    const t = setup();
    await seedChallenge(t, {
      email: "alice@example.com",
      userId: "user1",
      code: "code1",
      secret: "secret1",
    });
    await seedChallenge(t, {
      email: "bob@example.com",
      userId: "user2",
      code: "code2",
      secret: "secret2",
      expiresAt: Date.now() - 1000,
    });

    for (const args of [
      { code: "unknown", secret: "secret1" },
      { code: "code1", secret: "wrong" },
      { code: "code2", secret: "secret2" },
    ]) {
      expect(await t.query(api.challenge.getStatus, args)).toEqual({
        status: "invalid",
      });
    }
  });
});

describe("the challenge address", () => {
  test("keeps the case that the user gave, in the status and the record", async () => {
    const t = setup();
    await seedChallenge(t, {
      email: "Alice@Example.com",
      userId: "user1",
      code: "code1",
      secret: "secret1",
    });

    expect(
      await t.query(api.challenge.getStatus, {
        code: "code1",
        secret: "secret1",
      }),
    ).toMatchObject({ email: "Alice@Example.com" });

    await t.mutation(api.challenge.complete, {
      code: "code1",
      secret: "secret1",
    });
    expect(
      await t.query(api.verifiedEmails.getEmails, { userId: "user1" }),
    ).toEqual([{ email: "Alice@Example.com", isPrimary: true }]);
    // Lookups ignore the case.
    expect(
      await t.query(api.verifiedEmails.getUserIdByEmail, {
        email: "alice@example.com",
      }),
    ).toEqual({ userId: "user1", email: "Alice@Example.com" });
  });

  test("an address verified in another case fails with EMAIL_TAKEN", async () => {
    const t = setup();
    await seedEmail(t, "user2", "alice@example.com", true);
    await seedChallenge(t, {
      email: "Alice@Example.com",
      userId: "user1",
      code: "code1",
      secret: "secret1",
    });

    expect(
      await t.mutation(api.challenge.complete, {
        code: "code1",
        secret: "secret1",
      }),
    ).toEqual({ success: false, userError: { error: "EMAIL_TAKEN" } });
  });
});

describe("deleteUser with challenges", () => {
  test("removes the user's challenges and keeps the others", async () => {
    const t = setup();
    await seedChallenge(t, {
      email: "alice@example.com",
      userId: "user1",
      code: "code1",
      secret: "secret1",
    });
    await seedChallenge(t, {
      email: "bob@example.com",
      userId: "user2",
      code: "code2",
      secret: "secret2",
    });

    await t.mutation(api.verifiedEmails.deleteUser, { userId: "user1" });

    const remaining = await t.run(async (ctx) =>
      (await ctx.db.query("challenges").collect()).map((row) => row.email),
    );
    expect(remaining).toEqual(["bob@example.com"]);
  });
});

// `challenge.start` and `challenge.checkStart` read the client IP through
// `ctx.meta.getRequestMetadata()`, which convex-test does not supply, so
// every path that reaches them throws in tests.
// TODO: enable when convex-test supports ctx.meta.
describe("challenge.start", () => {
  test.skip("sends a link and returns the secret", () => {});
  test.skip("rejects a malformed address with INVALID_EMAIL", () => {});
  test.skip("rejects a taken address with EMAIL_TAKEN", () => {});
  test.skip("rate limits per destination email", () => {});
  test.skip("rate limits per client IP", () => {});
  test.skip("appends the code with ? or & as the URL requires", () => {});
  test.skip("records the sent email through the sender handle", () => {});
});

describe("challenge.checkStart", () => {
  test.skip("reports ok before any sends", () => {});
  test.skip("reports the retry delay once the limit is consumed", () => {});
});
