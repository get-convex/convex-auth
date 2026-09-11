import { afterEach, describe, expect, test, vi } from "vitest";
import { convexTest } from "convex-test";
import { register as registerRateLimiter } from "@convex-dev/rate-limiter/test";
import { register as registerBatchWorker } from "@convex-dev/batch-worker/test";
import {
  registerResendStub,
  stubEmailSender,
  sentEmails,
} from "../../testing/resend.ts";
import {
  CUSTOM_TTL_DEFAULT_MS,
  CUSTOM_TTL_MAX_MS,
  CUSTOM_TTL_MIN_MS,
} from "../helpers.ts";
import { api } from "../_generated/api.ts";
import schema from "../schema.ts";
import {
  seedEmail,
  seedChallenge,
  ADD_EMAIL,
  CUSTOM,
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
const URL = "https://app.example/reauthenticate";

/** The arguments of a `start` call, except the ones a test sets itself. */
async function startArgs(t: ReturnType<typeof setup>) {
  return {
    email: "alice@example.com",
    url: URL,
    emailSender: await stubEmailSender(t),
    purpose: PURPOSE,
    userId: "user1",
    subject: "Confirm it is you",
    intro: "Open this link to continue:",
  };
}

/** The code that the emailed link carries. */
function codeInLink(text: string | undefined): string {
  const match = /[?&]code=([^\s&]+)/.exec(text ?? "");
  if (match === null) {
    throw new Error("No code in the email: " + text);
  }
  return decodeURIComponent(match[1]);
}

afterEach(() => {
  vi.useRealTimers();
});

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

describe("challenge.custom.start", () => {
  test("sends the caller's subject and intro, and returns the secret and the challengeId", async () => {
    const t = setup();
    const result = await t
      .withRequestMetadata({ ip: IP })
      .mutation(api.challenge.custom.start, await startArgs(t));
    expect(result).toMatchObject({ success: true });
    if (!result.success) {
      throw new Error("unreachable");
    }
    expect(result.secret).toMatch(/^[A-Za-z0-9_-]{43}$/);

    const row = await t.run((ctx) =>
      ctx.db.get("challenges", result.challengeId),
    );
    expect(row).toMatchObject({
      email: "alice@example.com",
      purpose: { kind: "custom", userId: "user1", purpose: PURPOSE },
    });

    const sent = await sentEmails(t);
    expect(sent).toHaveLength(1);
    expect(sent[0].to).toEqual(["alice@example.com"]);
    expect(sent[0].subject).toBe("Confirm it is you");
    expect(sent[0].text).toContain("Open this link to continue:");
    expect(sent[0].text).toContain(`${URL}?code=`);

    // The link and the secret together complete the challenge.
    expect(
      await t.mutation(api.challenge.custom.complete, {
        code: codeInLink(sent[0].text),
        secret: result.secret,
        purpose: PURPOSE,
        userId: "user1",
      }),
    ).toEqual({ success: true, userId: "user1", email: "alice@example.com" });
  });

  test("uses the default TTL when ttlMs is absent", async () => {
    vi.useFakeTimers();
    const now = new Date("2026-01-01T00:00:00Z").getTime();
    vi.setSystemTime(now);
    const t = setup();
    const result = await t
      .withRequestMetadata({ ip: IP })
      .mutation(api.challenge.custom.start, await startArgs(t));
    if (!result.success) {
      throw new Error("unreachable");
    }
    const row = await t.run((ctx) =>
      ctx.db.get("challenges", result.challengeId),
    );
    expect(row?.expiresAt).toBe(now + CUSTOM_TTL_DEFAULT_MS);
    expect((await sentEmails(t))[0].text).toContain(
      "stops working after 15 minutes",
    );
  });

  test("throws when ttlMs is outside the bounds", async () => {
    const t = setup();
    const args = await startArgs(t);
    for (const ttlMs of [CUSTOM_TTL_MIN_MS - 1, CUSTOM_TTL_MAX_MS + 1, 0]) {
      await expect(
        t
          .withRequestMetadata({ ip: IP })
          .mutation(api.challenge.custom.start, { ...args, ttlMs }),
      ).rejects.toThrow(/ttlMs must be between/);
    }
    expect(await sentEmails(t)).toEqual([]);
  });

  test("does not check whether the address is verified", async () => {
    const t = setup();
    // The address belongs to another user; a custom flow does not care.
    await seedEmail(t, "user2", "alice@example.com", true);
    const result = await t
      .withRequestMetadata({ ip: IP })
      .mutation(api.challenge.custom.start, await startArgs(t));
    expect(result).toMatchObject({ success: true });
    expect(await sentEmails(t)).toHaveLength(1);
  });
});
