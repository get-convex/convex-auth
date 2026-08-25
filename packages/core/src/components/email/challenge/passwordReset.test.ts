import { describe, expect, test } from "vitest";
import { convexTest } from "convex-test";
import { register as registerRateLimiter } from "@convex-dev/rate-limiter/test";
import { api } from "../_generated/api.ts";
import schema from "../schema.ts";
import {
  seedEmail,
  seedChallenge,
  PASSWORD_RESET,
  modulesFromSubdir,
} from "../testSetup.ts";

const modules = modulesFromSubdir(import.meta.glob("../**/*.ts"), "challenge");

function setup() {
  const t = convexTest(schema, modules);
  registerRateLimiter(t);
  return t;
}

describe("challenge.passwordReset.complete", () => {
  test("returns the userId and writes nothing", async () => {
    const t = setup();
    await seedEmail(t, "user1", "alice@example.com", true);
    await seedChallenge(t, {
      email: "alice@example.com",
      userId: "user1",
      purpose: PASSWORD_RESET,
      code: "code1",
      secret: "secret1",
    });

    const result = await t.mutation(api.challenge.passwordReset.complete, {
      code: "code1",
      secret: "secret1",
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

  test("fails when the address is no longer verified for the user", async () => {
    const t = setup();
    await seedChallenge(t, {
      email: "alice@example.com",
      userId: "user1",
      purpose: PASSWORD_RESET,
      code: "code1",
      secret: "secret1",
    });
    // The address was removed (or re-verified by another user) after the
    // flow started, so the proof is stale.

    const result = await t.mutation(api.challenge.passwordReset.complete, {
      code: "code1",
      secret: "secret1",
    });
    expect(result).toEqual({
      success: false,
      userError: { error: "INVALID_LINK" },
    });
  });

  test("matches a verified address written in another case", async () => {
    const t = setup();
    await seedEmail(t, "user1", "Alice@Example.com", true);
    await seedChallenge(t, {
      // The user typed the address differently when starting the reset.
      email: "ALICE@example.com",
      userId: "user1",
      purpose: PASSWORD_RESET,
      code: "code1",
      secret: "secret1",
    });

    expect(
      await t.mutation(api.challenge.passwordReset.complete, {
        code: "code1",
        secret: "secret1",
      }),
    ).toEqual({
      success: true,
      userId: "user1",
      email: "ALICE@example.com",
    });
  });
});

// TODO: enable when convex-test supports ctx.meta (see addEmail.test.ts).
describe("challenge.passwordReset.start", () => {
  test.skip("resolves the user by email", () => {});
  test.skip("rejects an unknown address with EMAIL_NOT_FOUND", () => {});
});
