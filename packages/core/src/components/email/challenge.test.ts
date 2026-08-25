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

/** Complete a seeded challenge and return its proof. */
async function completeSeeded(
  t: ReturnType<typeof setup>,
  args: { code: string; secret: string; purpose: string },
): Promise<string> {
  const result = await t.mutation(api.challenge.complete, args);
  if (!result.success) {
    throw new Error(`Completion failed: ${result.userError.error}`);
  }
  return result.proof;
}

describe("challenge.complete", () => {
  test("returns the proof, the address, the user and the purpose", async () => {
    const t = setup();
    await seedChallenge(t, {
      email: "alice@example.com",
      userId: "user1",
      purpose: "signUp",
      code: "code1",
      secret: "secret1",
    });

    const result = await t.mutation(api.challenge.complete, {
      code: "code1",
      secret: "secret1",
      purpose: "signUp",
    });
    expect(result).toMatchObject({
      success: true,
      email: "alice@example.com",
      userId: "user1",
      purpose: "signUp",
    });
    expect(result.success && result.proof).toMatch(/^[A-Za-z0-9_-]{43}$/);

    // Completion writes nothing to verifiedEmails.
    expect(
      await t.query(api.verifiedEmails.getEmails, { userId: "user1" }),
    ).toEqual([]);
  });

  test("returns userId null for a challenge started without a user", async () => {
    const t = setup();
    await seedChallenge(t, {
      email: "alice@example.com",
      purpose: "recovery",
      code: "code1",
      secret: "secret1",
    });

    const result = await t.mutation(api.challenge.complete, {
      code: "code1",
      secret: "secret1",
      purpose: "recovery",
    });
    expect(result).toMatchObject({
      success: true,
      email: "alice@example.com",
      userId: null,
    });
  });

  test("does not check the address against verifiedEmails", async () => {
    // Recovery challenges target an address that is already verified. The
    // component leaves the meaning of the purpose to the caller.
    const t = setup();
    await seedEmail(t, "user1", "alice@example.com", true);
    await seedChallenge(t, {
      email: "alice@example.com",
      userId: "user1",
      purpose: "reauth",
      code: "code1",
      secret: "secret1",
    });

    const result = await t.mutation(api.challenge.complete, {
      code: "code1",
      secret: "secret1",
      purpose: "reauth",
    });
    expect(result).toMatchObject({ success: true, userId: "user1" });
  });

  test("the claim is one-shot: a second completion fails", async () => {
    const t = setup();
    await seedChallenge(t, {
      email: "alice@example.com",
      userId: "user1",
      purpose: "signUp",
      code: "code1",
      secret: "secret1",
    });

    const first = await t.mutation(api.challenge.complete, {
      code: "code1",
      secret: "secret1",
      purpose: "signUp",
    });
    expect(first).toMatchObject({ success: true });

    const second = await t.mutation(api.challenge.complete, {
      code: "code1",
      secret: "secret1",
      purpose: "signUp",
    });
    expect(second).toEqual({
      success: false,
      userError: { error: "INVALID_LINK" },
    });
    // The second attempt also removed the completed row, so the proof from
    // the first completion is gone.
    expect(
      await t.mutation(api.verifiedEmails.add, {
        proof: first.success ? first.proof : "",
        setPrimary: false,
      }),
    ).toEqual({ success: false, userError: { error: "INVALID_PROOF" } });
  });

  test("a wrong secret fails and still consumes the link", async () => {
    const t = setup();
    await seedChallenge(t, {
      email: "alice@example.com",
      userId: "user1",
      purpose: "signUp",
      code: "code1",
      secret: "secret1",
    });

    expect(
      await t.mutation(api.challenge.complete, {
        code: "code1",
        secret: "wrong",
        purpose: "signUp",
      }),
    ).toEqual({ success: false, userError: { error: "INVALID_LINK" } });
    // The row is gone: even the right secret cannot complete it now.
    expect(
      await t.mutation(api.challenge.complete, {
        code: "code1",
        secret: "secret1",
        purpose: "signUp",
      }),
    ).toEqual({ success: false, userError: { error: "INVALID_LINK" } });
  });

  test("an expired link fails with INVALID_LINK", async () => {
    const t = setup();
    await seedChallenge(t, {
      email: "alice@example.com",
      userId: "user1",
      purpose: "signUp",
      code: "code1",
      secret: "secret1",
      expiresAt: Date.now() - 1000,
    });

    expect(
      await t.mutation(api.challenge.complete, {
        code: "code1",
        secret: "secret1",
        purpose: "signUp",
      }),
    ).toEqual({ success: false, userError: { error: "INVALID_LINK" } });
  });

  test("a purpose mismatch fails with INVALID_LINK", async () => {
    const t = setup();
    await seedChallenge(t, {
      email: "alice@example.com",
      userId: "user1",
      purpose: "signUp",
      code: "code1",
      secret: "secret1",
    });

    expect(
      await t.mutation(api.challenge.complete, {
        code: "code1",
        secret: "secret1",
        purpose: "recovery",
      }),
    ).toEqual({ success: false, userError: { error: "INVALID_LINK" } });
  });

  test("an unknown code fails with INVALID_LINK", async () => {
    const t = setup();
    expect(
      await t.mutation(api.challenge.complete, {
        code: "nope",
        secret: "secret1",
        purpose: "signUp",
      }),
    ).toEqual({ success: false, userError: { error: "INVALID_LINK" } });
  });
});

describe("verifiedEmails.add", () => {
  test("records the address; the first email becomes primary", async () => {
    const t = setup();
    await seedChallenge(t, {
      email: "alice@example.com",
      userId: "user1",
      purpose: "signUp",
      code: "code1",
      secret: "secret1",
    });
    const proof = await completeSeeded(t, {
      code: "code1",
      secret: "secret1",
      purpose: "signUp",
    });

    const result = await t.mutation(api.verifiedEmails.add, {
      proof,
      setPrimary: false,
    });
    expect(result).toEqual({
      success: true,
      userId: "user1",
      email: "alice@example.com",
      isPrimary: true,
      previousPrimaryEmail: null,
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
      purpose: "addEmail",
      code: "code1",
      secret: "secret1",
    });
    const proof = await completeSeeded(t, {
      code: "code1",
      secret: "secret1",
      purpose: "addEmail",
    });

    const result = await t.mutation(api.verifiedEmails.add, {
      proof,
      setPrimary: false,
    });
    expect(result).toMatchObject({ success: true, isPrimary: false });
    const emails = await t.query(api.verifiedEmails.getEmails, {
      userId: "user1",
    });
    expect(emails).toEqual([
      { email: "alice@example.com", isPrimary: true },
      { email: "alice2@example.com", isPrimary: false },
    ]);
  });

  test("setPrimary replaces the old primary and returns it", async () => {
    const t = setup();
    await seedEmail(t, "user1", "old@example.com", true);
    await seedEmail(t, "user1", "other@example.com", false);
    await seedChallenge(t, {
      email: "new@example.com",
      userId: "user1",
      purpose: "changeEmail",
      code: "code1",
      secret: "secret1",
    });
    const proof = await completeSeeded(t, {
      code: "code1",
      secret: "secret1",
      purpose: "changeEmail",
    });

    const result = await t.mutation(api.verifiedEmails.add, {
      proof,
      setPrimary: true,
    });
    expect(result).toEqual({
      success: true,
      userId: "user1",
      email: "new@example.com",
      isPrimary: true,
      previousPrimaryEmail: "old@example.com",
    });
    const emails = await t.query(api.verifiedEmails.getEmails, {
      userId: "user1",
    });
    expect(emails).toEqual([
      { email: "other@example.com", isPrimary: false },
      { email: "new@example.com", isPrimary: true },
    ]);
  });

  test("the proof is one-shot", async () => {
    const t = setup();
    await seedChallenge(t, {
      email: "alice@example.com",
      userId: "user1",
      purpose: "signUp",
      code: "code1",
      secret: "secret1",
    });
    const proof = await completeSeeded(t, {
      code: "code1",
      secret: "secret1",
      purpose: "signUp",
    });

    await t.mutation(api.verifiedEmails.add, { proof, setPrimary: false });
    expect(
      await t.mutation(api.verifiedEmails.add, { proof, setPrimary: false }),
    ).toEqual({ success: false, userError: { error: "INVALID_PROOF" } });
    expect(
      await t.query(api.verifiedEmails.getEmails, { userId: "user1" }),
    ).toHaveLength(1);
  });

  test("an unknown or expired proof fails with INVALID_PROOF", async () => {
    const t = setup();
    expect(
      await t.mutation(api.verifiedEmails.add, {
        proof: "nope",
        setPrimary: false,
      }),
    ).toEqual({ success: false, userError: { error: "INVALID_PROOF" } });

    await seedChallenge(t, {
      email: "alice@example.com",
      userId: "user1",
      purpose: "signUp",
      code: "code1",
      secret: "secret1",
      expiresAt: Date.now() + 10,
    });
    const proof = await completeSeeded(t, {
      code: "code1",
      secret: "secret1",
      purpose: "signUp",
    });
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(
      await t.mutation(api.verifiedEmails.add, { proof, setPrimary: false }),
    ).toEqual({ success: false, userError: { error: "INVALID_PROOF" } });
  });

  test("an address verified by another user after the start fails with EMAIL_TAKEN", async () => {
    const t = setup();
    await seedChallenge(t, {
      email: "alice@example.com",
      userId: "user1",
      purpose: "signUp",
      code: "code1",
      secret: "secret1",
    });
    await seedEmail(t, "user2", "alice@example.com", true);
    const proof = await completeSeeded(t, {
      code: "code1",
      secret: "secret1",
      purpose: "signUp",
    });

    expect(
      await t.mutation(api.verifiedEmails.add, { proof, setPrimary: false }),
    ).toEqual({ success: false, userError: { error: "EMAIL_TAKEN" } });
    expect(
      await t.query(api.verifiedEmails.getEmails, { userId: "user1" }),
    ).toEqual([]);
  });

  test("throws for a proof from a challenge without a user", async () => {
    const t = setup();
    await seedChallenge(t, {
      email: "alice@example.com",
      purpose: "recovery",
      code: "code1",
      secret: "secret1",
    });
    const proof = await completeSeeded(t, {
      code: "code1",
      secret: "secret1",
      purpose: "recovery",
    });

    await expect(
      t.mutation(api.verifiedEmails.add, { proof, setPrimary: false }),
    ).rejects.toThrow(/started with a userId/);
  });
});

describe("challenge.getStatus", () => {
  test("reports a pending challenge with its purpose and email", async () => {
    const t = setup();
    await seedChallenge(t, {
      email: "alice@example.com",
      userId: "user1",
      purpose: "changeEmail",
      code: "code1",
      secret: "secret1",
    });

    const status = await t.query(api.challenge.getStatus, {
      code: "code1",
      secret: "secret1",
    });
    expect(status).toEqual({
      status: "pending",
      purpose: "changeEmail",
      email: "alice@example.com",
    });

    // The query does not claim the challenge: completion still works.
    const result = await t.mutation(api.challenge.complete, {
      code: "code1",
      secret: "secret1",
      purpose: "changeEmail",
    });
    expect(result).toMatchObject({ success: true });
  });

  test("reports invalid for an unknown code, a wrong secret, an expired and a completed challenge", async () => {
    const t = setup();
    await seedChallenge(t, {
      email: "alice@example.com",
      userId: "user1",
      purpose: "signUp",
      code: "code1",
      secret: "secret1",
    });
    await seedChallenge(t, {
      email: "bob@example.com",
      userId: "user2",
      purpose: "signUp",
      code: "code2",
      secret: "secret2",
      expiresAt: Date.now() - 1000,
    });
    await seedChallenge(t, {
      email: "carol@example.com",
      userId: "user3",
      purpose: "signUp",
      code: "code3",
      secret: "secret3",
    });
    await completeSeeded(t, {
      code: "code3",
      secret: "secret3",
      purpose: "signUp",
    });

    for (const args of [
      { code: "unknown", secret: "secret1" },
      { code: "code1", secret: "wrong" },
      { code: "code2", secret: "secret2" },
      { code: "code3", secret: "secret3" },
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
      purpose: "signUp",
      code: "code1",
      secret: "secret1",
    });

    expect(
      await t.query(api.challenge.getStatus, {
        code: "code1",
        secret: "secret1",
      }),
    ).toMatchObject({ email: "Alice@Example.com" });

    const proof = await completeSeeded(t, {
      code: "code1",
      secret: "secret1",
      purpose: "signUp",
    });
    await t.mutation(api.verifiedEmails.add, { proof, setPrimary: false });
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
      purpose: "signUp",
      code: "code1",
      secret: "secret1",
    });
    const proof = await completeSeeded(t, {
      code: "code1",
      secret: "secret1",
      purpose: "signUp",
    });

    expect(
      await t.mutation(api.verifiedEmails.add, { proof, setPrimary: false }),
    ).toEqual({ success: false, userError: { error: "EMAIL_TAKEN" } });
  });
});

describe("deleteUser with challenges", () => {
  test("removes the user's challenges and keeps the others", async () => {
    const t = setup();
    await seedChallenge(t, {
      email: "alice@example.com",
      userId: "user1",
      purpose: "signUp",
      code: "code1",
      secret: "secret1",
    });
    await seedChallenge(t, {
      email: "bob@example.com",
      userId: "user2",
      purpose: "signUp",
      code: "code2",
      secret: "secret2",
    });
    await seedChallenge(t, {
      email: "carol@example.com",
      purpose: "recovery",
      code: "code3",
      secret: "secret3",
    });

    await t.mutation(api.verifiedEmails.deleteUser, { userId: "user1" });

    const remaining = await t.run(async (ctx) =>
      (await ctx.db.query("challenges").collect()).map((row) => row.email),
    );
    expect(remaining).toEqual(["bob@example.com", "carol@example.com"]);
  });
});

// `challenge.start` and `challenge.checkStart` read the client IP through
// `ctx.meta.getRequestMetadata()`, which convex-test does not supply, so
// every path that reaches them throws in tests.
// TODO: enable when convex-test supports ctx.meta.
describe("challenge.start", () => {
  test.skip("sends a link and returns the secret", () => {});
  test.skip("stores the purpose, the user and the expiry", () => {});
  test.skip("rejects a malformed address with INVALID_EMAIL", () => {});
  test.skip("rate limits per destination email", () => {});
  test.skip("rate limits per client IP", () => {});
  test.skip("appends the code with ? or & as the URL requires", () => {});
  test.skip("records the sent email through the sender handle", () => {});
});

describe("challenge.checkStart", () => {
  test.skip("reports ok before any sends", () => {});
  test.skip("reports the retry delay once the limit is consumed", () => {});
});
