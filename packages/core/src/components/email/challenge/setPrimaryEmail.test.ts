import { describe, expect, test } from "vitest";
import { convexTest } from "convex-test";
import { register as registerRateLimiter } from "@convex-dev/rate-limiter/test";
import { register as registerBatchWorker } from "@convex-dev/batch-worker/test";
import {
  registerResendStub,
  stubEmailSender,
  sentEmails,
} from "../../testing/resend.ts";
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
  registerBatchWorker(t);
  registerResendStub(t);
  return t;
}

const IP = "203.0.113.7";
const URL = "https://app.example/confirm-email-change";

/** The code that the emailed link carries. */
function codeInLink(text: string | undefined): string {
  const match = /[?&]code=([^\s&]+)/.exec(text ?? "");
  if (match === null) {
    throw new Error("No code in the email: " + text);
  }
  return decodeURIComponent(match[1]);
}

describe("challenge.setPrimaryEmail.complete", () => {
  test("replaces and returns the old primary", async () => {
    const t = setup();
    await seedEmail(t, "user1", "old@example.com", true);
    await seedChallenge(t, {
      email: "new@example.com",
      purpose: SET_PRIMARY_EMAIL("user1"),
      code: "code1",
      secret: "secret1",
    });

    const result = await t.mutation(api.challenge.setPrimaryEmail.complete, {
      code: "code1",
      secret: "secret1",
      userId: "user1",
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
      purpose: SET_PRIMARY_EMAIL("user1"),
      code: "code1",
      secret: "secret1",
    });

    const result = await t.mutation(api.challenge.setPrimaryEmail.complete, {
      code: "code1",
      secret: "secret1",
      userId: "user1",
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
      purpose: SET_PRIMARY_EMAIL("user1"),
      code: "code1",
      secret: "secret1",
    });
    await seedEmail(t, "user2", "new@example.com", true);

    expect(
      await t.mutation(api.challenge.setPrimaryEmail.complete, {
        code: "code1",
        secret: "secret1",
        userId: "user1",
      }),
    ).toEqual({ success: false, userError: { error: "EMAIL_TAKEN" } });
    // The old primary stays in place.
    expect(
      await t.query(api.verifiedEmails.getEmails, { userId: "user1" }),
    ).toEqual([{ email: "old@example.com", isPrimary: true }]);
  });
});

describe("concurrent challenges for one address", () => {
  test("the other challenge stays pending, then fails with EMAIL_TAKEN", async () => {
    const t = setup();
    // Two sign-ups race for one address; the first completion wins.
    await seedChallenge(t, {
      email: "alice@example.com",
      purpose: SET_PRIMARY_EMAIL("user1"),
      code: "code1",
      secret: "secret1",
    });
    await seedChallenge(t, {
      email: "alice@example.com",
      purpose: SET_PRIMARY_EMAIL("user2"),
      code: "code2",
      secret: "secret2",
    });

    const first = await t.mutation(api.challenge.setPrimaryEmail.complete, {
      code: "code1",
      secret: "secret1",
      userId: "user1",
    });
    expect(first).toMatchObject({ success: true, userId: "user1" });

    // The other challenge is not deleted. It stays pending, and fails only
    // when the user tries to complete it.
    expect(
      await t.query(api.challenge.setPrimaryEmail.getStatus, {
        code: "code2",
        secret: "secret2",
        userId: "user2",
      }),
    ).toMatchObject({ status: "pending" });
    const second = await t.mutation(api.challenge.setPrimaryEmail.complete, {
      code: "code2",
      secret: "secret2",
      userId: "user2",
    });
    expect(second).toEqual({
      success: false,
      userError: { error: "EMAIL_TAKEN" },
    });
  });

  test("a challenge that uses another case of the address fails too", async () => {
    const t = setup();
    await seedChallenge(t, {
      email: "Alice@Example.com",
      purpose: SET_PRIMARY_EMAIL("user1"),
      code: "code1",
      secret: "secret1",
    });
    await seedChallenge(t, {
      email: "alice@EXAMPLE.com",
      purpose: SET_PRIMARY_EMAIL("user2"),
      code: "code2",
      secret: "secret2",
    });

    expect(
      await t.mutation(api.challenge.setPrimaryEmail.complete, {
        code: "code1",
        secret: "secret1",
        userId: "user1",
      }),
    ).toMatchObject({ success: true, userId: "user1" });
    expect(
      await t.mutation(api.challenge.setPrimaryEmail.complete, {
        code: "code2",
        secret: "secret2",
        userId: "user2",
      }),
    ).toEqual({ success: false, userError: { error: "EMAIL_TAKEN" } });
  });
});

describe("challenge.setPrimaryEmail.start", () => {
  test("sends a link to the new address, and the completion replaces the old one", async () => {
    const t = setup();
    await seedEmail(t, "user1", "old@example.com", true);
    const result = await t
      .withRequestMetadata({ ip: IP })
      .mutation(api.challenge.setPrimaryEmail.start, {
        email: "new@example.com",
        url: URL,
        emailSender: await stubEmailSender(t),
        userId: "user1",
      });
    expect(result).toMatchObject({ success: true });
    if (!result.success) {
      throw new Error("unreachable");
    }
    const row = await t.run((ctx) =>
      ctx.db.get("challenges", result.challengeId),
    );
    expect(row).toMatchObject({
      email: "new@example.com",
      purpose: { kind: "setPrimaryEmail", userId: "user1" },
    });

    const sent = await sentEmails(t);
    expect(sent).toHaveLength(1);
    expect(sent[0].to).toEqual(["new@example.com"]);
    expect(sent[0].subject).toBe("Validate your email address");
    expect(sent[0].text).toContain(`${URL}?code=`);

    expect(
      await t.mutation(api.challenge.setPrimaryEmail.complete, {
        code: codeInLink(sent[0].text),
        secret: result.secret,
        userId: "user1",
      }),
    ).toEqual({
      success: true,
      userId: "user1",
      email: "new@example.com",
      previousPrimaryEmail: "old@example.com",
    });
    expect(
      await t.query(api.verifiedEmails.getEmails, { userId: "user1" }),
    ).toEqual([{ email: "new@example.com", isPrimary: true }]);
  });

  test("rejects a taken address with EMAIL_TAKEN", async () => {
    const t = setup();
    await seedEmail(t, "user2", "new@example.com", true);
    const result = await t
      .withRequestMetadata({ ip: IP })
      .mutation(api.challenge.setPrimaryEmail.start, {
        email: "new@example.com",
        url: URL,
        emailSender: await stubEmailSender(t),
        userId: "user1",
      });
    expect(result).toEqual({
      success: false,
      userError: { error: "EMAIL_TAKEN" },
    });
    expect(await sentEmails(t)).toEqual([]);
  });
});
