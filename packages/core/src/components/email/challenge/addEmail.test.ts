import { describe, expect, test } from "vitest";
import { convexTest } from "convex-test";
import { register as registerRateLimiter } from "@convex-dev/rate-limiter/test";
import { api } from "../_generated/api.ts";
import schema from "../schema.ts";
import {
  seedEmail,
  seedChallenge,
  ADD_EMAIL,
  modulesFromSubdir,
} from "../testSetup.ts";

const modules = modulesFromSubdir(import.meta.glob("../**/*.ts"), "challenge");

function setup() {
  const t = convexTest(schema, modules);
  registerRateLimiter(t);
  return t;
}

describe("challenge.addEmail.complete", () => {
  test("records the address; the first email becomes primary", async () => {
    const t = setup();
    await seedChallenge(t, {
      email: "alice@example.com",
      userId: "user1",
      purpose: ADD_EMAIL,
      code: "code1",
      secret: "secret1",
    });

    const result = await t.mutation(api.challenge.addEmail.complete, {
      code: "code1",
      secret: "secret1",
    });
    expect(result).toEqual({
      success: true,
      userId: "user1",
      email: "alice@example.com",
    });
    // `addEmail` does not ask for primary, but the first email is always
    // primary.
    expect(
      await t.query(api.verifiedEmails.getEmails, { userId: "user1" }),
    ).toEqual([{ email: "alice@example.com", isPrimary: true }]);
  });

  test("a later email stays secondary", async () => {
    const t = setup();
    await seedEmail(t, "user1", "alice@example.com", true);
    await seedChallenge(t, {
      email: "alice@work.example",
      userId: "user1",
      purpose: ADD_EMAIL,
      code: "code1",
      secret: "secret1",
    });

    const result = await t.mutation(api.challenge.addEmail.complete, {
      code: "code1",
      secret: "secret1",
    });
    expect(result).toMatchObject({ success: true });
    const emails = await t.query(api.verifiedEmails.getEmails, {
      userId: "user1",
    });
    expect(emails).toContainEqual({
      email: "alice@work.example",
      isPrimary: false,
    });
    expect(emails).toContainEqual({
      email: "alice@example.com",
      isPrimary: true,
    });
  });

  test("an address verified after the start fails with EMAIL_TAKEN", async () => {
    const t = setup();
    await seedChallenge(t, {
      email: "alice@example.com",
      userId: "user1",
      purpose: ADD_EMAIL,
      code: "code1",
      secret: "secret1",
    });
    // Another user verifies the address while the link is in flight.
    await seedEmail(t, "user2", "alice@example.com", true);

    const result = await t.mutation(api.challenge.addEmail.complete, {
      code: "code1",
      secret: "secret1",
    });
    expect(result).toEqual({
      success: false,
      userError: { error: "EMAIL_TAKEN" },
    });
    // The address still belongs to the user who verified it first.
    expect(
      await t.query(api.verifiedEmails.getUserIdByEmail, {
        email: "alice@example.com",
      }),
    ).toEqual({ userId: "user2", email: "alice@example.com" });
  });

  test("records the case that the user gave", async () => {
    const t = setup();
    await seedChallenge(t, {
      email: "Alice@Example.com",
      userId: "user1",
      purpose: ADD_EMAIL,
      code: "code1",
      secret: "secret1",
    });

    const result = await t.mutation(api.challenge.addEmail.complete, {
      code: "code1",
      secret: "secret1",
    });
    expect(result).toMatchObject({
      success: true,
      email: "Alice@Example.com",
    });
    expect(
      await t.query(api.verifiedEmails.getEmails, { userId: "user1" }),
    ).toEqual([{ email: "Alice@Example.com", isPrimary: true }]);
    // The recorded row carries both forms, so a lookup in any case finds it.
    expect(
      await t.query(api.verifiedEmails.getUserIdByEmail, {
        email: "ALICE@EXAMPLE.COM",
      }),
    ).toEqual({ userId: "user1", email: "Alice@Example.com" });
  });

  test("an address verified in another case fails with EMAIL_TAKEN", async () => {
    const t = setup();
    await seedChallenge(t, {
      email: "Alice@Example.com",
      userId: "user1",
      purpose: ADD_EMAIL,
      code: "code1",
      secret: "secret1",
    });
    // Another user verifies the same address, written differently.
    await seedEmail(t, "user2", "alice@EXAMPLE.com", true);

    expect(
      await t.mutation(api.challenge.addEmail.complete, {
        code: "code1",
        secret: "secret1",
      }),
    ).toEqual({ success: false, userError: { error: "EMAIL_TAKEN" } });
  });
});

// The `start` mutations read the client IP through
// `ctx.meta.getRequestMetadata()`, which convex-test does not supply, so
// every path that reaches them throws in tests.
// TODO: enable when convex-test supports ctx.meta.
describe("challenge.addEmail.start", () => {
  test.skip("sends a link and returns the secret", () => {});
  test.skip("rejects a malformed address with INVALID_EMAIL", () => {});
  test.skip("rejects a taken address with EMAIL_TAKEN", () => {});
  test.skip("rate limits per destination email", () => {});
  test.skip("rate limits per client IP", () => {});
  test.skip("appends the code with ? or & as the URL requires", () => {});
  test.skip("records the sent email through the sender handle", () => {});
});
