import { describe, expect, test } from "vitest";
import { convexTest } from "convex-test";
import { register as registerRateLimiter } from "@convex-dev/rate-limiter/test";
import { api } from "../_generated/api.ts";
import schema from "../schema.ts";
import {
  seedEmail,
  seedChallenge,
  SET_PRIMARY_EMAIL,
  modulesFromSubdir,
} from "../testSetup.ts";

const modules = modulesFromSubdir(import.meta.glob("../**/*.ts"), "challenge");

function setup() {
  const t = convexTest(schema, modules);
  registerRateLimiter(t);
  return t;
}

describe("challenge.setPrimaryEmail.complete", () => {
  test("replaces and returns the old primary", async () => {
    const t = setup();
    await seedEmail(t, "user1", "old@example.com", true);
    await seedChallenge(t, {
      email: "new@example.com",
      userId: "user1",
      purpose: SET_PRIMARY_EMAIL,
      code: "code1",
      secret: "secret1",
    });

    const result = await t.mutation(api.challenge.setPrimaryEmail.complete, {
      code: "code1",
      secret: "secret1",
    });
    expect(result).toEqual({
      success: true,
      userId: "user1",
      email: "new@example.com",
      previousPrimaryEmail: "old@example.com",
    });
    // The old primary is gone; the new address is the only primary.
    expect(
      await t.query(api.verifiedEmails.getEmails, { userId: "user1" }),
    ).toEqual([{ email: "new@example.com", isPrimary: true }]);
    expect(
      await t.query(api.verifiedEmails.getUserIdByEmail, {
        email: "old@example.com",
      }),
    ).toBeNull();
  });

  test("a first email has no previous primary", async () => {
    const t = setup();
    await seedChallenge(t, {
      email: "alice@example.com",
      userId: "user1",
      purpose: SET_PRIMARY_EMAIL,
      code: "code1",
      secret: "secret1",
    });

    const result = await t.mutation(api.challenge.setPrimaryEmail.complete, {
      code: "code1",
      secret: "secret1",
    });
    expect(result).toEqual({
      success: true,
      userId: "user1",
      email: "alice@example.com",
      previousPrimaryEmail: null,
    });
    expect(
      await t.query(api.verifiedEmails.getEmails, { userId: "user1" }),
    ).toEqual([{ email: "alice@example.com", isPrimary: true }]);
  });

  test("an address verified after the start fails with EMAIL_TAKEN", async () => {
    const t = setup();
    await seedEmail(t, "user1", "old@example.com", true);
    await seedChallenge(t, {
      email: "new@example.com",
      userId: "user1",
      purpose: SET_PRIMARY_EMAIL,
      code: "code1",
      secret: "secret1",
    });
    await seedEmail(t, "user2", "new@example.com", true);

    expect(
      await t.mutation(api.challenge.setPrimaryEmail.complete, {
        code: "code1",
        secret: "secret1",
      }),
    ).toEqual({ success: false, userError: { error: "EMAIL_TAKEN" } });
    // The old primary stays in place.
    expect(
      await t.query(api.verifiedEmails.getEmails, { userId: "user1" }),
    ).toEqual([{ email: "old@example.com", isPrimary: true }]);
  });
});

// TODO: enable when convex-test supports ctx.meta (see addEmail.test.ts).
describe("challenge.setPrimaryEmail.start", () => {
  test.skip("sends a link and returns the secret", () => {});
  test.skip("rejects a taken address with EMAIL_TAKEN", () => {});
});
