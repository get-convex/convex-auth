import { convexTest } from "convex-test";
import { beforeEach, describe, expect, test } from "vitest";
import { register as registerRateLimiter } from "@convex-dev/rate-limiter/test";
import { api } from "./_generated/api";
import schema from "./schema";
import {
  getLastEmailedCode,
  getSendEmailCalls,
  resetSendEmailCalls,
} from "./testApp";

const modules = import.meta.glob("./**/*.ts");

// A handle string convex-test resolves to the spy `sendEmail` in `testApp.ts`
// (see the precedent in `core.test.ts`).
const SEND_EMAIL_HANDLE = "testApp:sendEmail";

const EMAIL = "alice@example.com";
const USER_ID = "user_alice";

const send = {
  handle: SEND_EMAIL_HANDLE,
  from: "My App <auth@example.com>",
  apiKey: "test-key",
  testMode: true,
};

function setup() {
  const t = convexTest(schema, modules);
  // The component mounts the rate limiter for both throttles.
  registerRateLimiter(t);
  return t;
}

beforeEach(() => {
  resetSendEmailCalls();
});

/** Create a session and return `{ session, code }`, asserting an email was sent. */
async function createSession(
  t: ReturnType<typeof setup>,
  overrides: { userId?: string; email?: string } = {},
) {
  const result = await t.mutation(api.public.createSession, {
    userId: overrides.userId ?? USER_ID,
    email: overrides.email ?? EMAIL,
    send,
  });
  if (!result.ok) {
    throw new Error(`createSession failed: ${result.userError.error}`);
  }
  return { session: result.session, code: getLastEmailedCode() };
}

describe("createSession + consumeSession happy path", () => {
  test("emails a code and confirms with the secret + code", async () => {
    const t = setup();
    const { session, code } = await createSession(t);

    // The email went to the right address, from the right sender, with a body
    // that contains the code.
    const calls = getSendEmailCalls();
    expect(calls).toHaveLength(1);
    expect(calls[0].to).toEqual([EMAIL]);
    expect(calls[0].from).toBe(send.from);
    expect(calls[0].text).toContain(code);
    expect(calls[0].options.testMode).toBe(true);

    const result = await t.mutation(api.public.consumeSession, {
      session,
      code,
    });
    expect(result).toEqual({ valid: true, userId: USER_ID, email: EMAIL });
  });

  test("normalizes the entered code (case / whitespace insensitive)", async () => {
    const t = setup();
    const { session, code } = await createSession(t);
    const result = await t.mutation(api.public.consumeSession, {
      session,
      code: `  ${code.toLowerCase()}  `,
    });
    expect(result).toEqual({ valid: true, userId: USER_ID, email: EMAIL });
  });
});

describe("consumeSession failures", () => {
  test("is single-use: a confirmed session can't be reused", async () => {
    const t = setup();
    const { session, code } = await createSession(t);
    await t.mutation(api.public.consumeSession, { session, code });
    const second = await t.mutation(api.public.consumeSession, {
      session,
      code,
    });
    expect(second).toEqual({ valid: false, error: "INVALID" });
  });

  test("rejects a wrong code without consuming the session", async () => {
    const t = setup();
    const { session, code } = await createSession(t);
    const wrongCode = code === "AAAAAAAA" ? "BBBBBBBB" : "AAAAAAAA";

    const bad = await t.mutation(api.public.consumeSession, {
      session,
      code: wrongCode,
    });
    expect(bad).toEqual({ valid: false, error: "INVALID" });

    // The row survives, so the correct code still works.
    const good = await t.mutation(api.public.consumeSession, { session, code });
    expect(good).toEqual({ valid: true, userId: USER_ID, email: EMAIL });
  });

  test("rejects a wrong secret (right id, tampered secret)", async () => {
    const t = setup();
    const { session, code } = await createSession(t);
    const [id] = session.split(".");
    const tampered = `${id}.not-the-real-secret`;
    const result = await t.mutation(api.public.consumeSession, {
      session: tampered,
      code,
    });
    expect(result).toEqual({ valid: false, error: "INVALID" });
  });

  test("rejects a malformed session string", async () => {
    const t = setup();
    await createSession(t);
    const result = await t.mutation(api.public.consumeSession, {
      session: "no-separator",
      code: "AAAAAAAA",
    });
    expect(result).toEqual({ valid: false, error: "INVALID" });
  });

  test("expires after the TTL and deletes the row", async () => {
    const t = setup();
    const { session, code } = await createSession(t);

    // Force the session past its expiry.
    await t.run(async (ctx) => {
      const row = await ctx.db.query("emailValidationSessions").unique();
      await ctx.db.patch(row!._id, { expiresAt: Date.now() - 1000 });
    });

    const result = await t.mutation(api.public.consumeSession, {
      session,
      code,
    });
    expect(result).toEqual({ valid: false, error: "EXPIRED" });

    // The expired row was deleted.
    const remaining = await t.run(
      async (ctx) =>
        (await ctx.db.query("emailValidationSessions").collect()).length,
    );
    expect(remaining).toBe(0);
  });
});

describe("session replacement", () => {
  test("a new session for the same user invalidates the previous one", async () => {
    const t = setup();
    const first = await createSession(t);
    const second = await createSession(t);

    // Only one row exists for the user.
    const count = await t.run(
      async (ctx) =>
        (await ctx.db.query("emailValidationSessions").collect()).length,
    );
    expect(count).toBe(1);

    // The first session no longer confirms...
    expect(
      await t.mutation(api.public.consumeSession, {
        session: first.session,
        code: first.code,
      }),
    ).toEqual({ valid: false, error: "INVALID" });

    // ...but the second does.
    expect(
      await t.mutation(api.public.consumeSession, {
        session: second.session,
        code: second.code,
      }),
    ).toEqual({ valid: true, userId: USER_ID, email: EMAIL });
  });
});

describe("rate limiting", () => {
  test("throttles sends per email address", async () => {
    const t = setup();
    // Capacity is 3 for the send bucket; the 4th send to the same address in the
    // window is rejected. Vary the userId so row-replacement isn't the cause.
    for (let i = 0; i < 3; i++) {
      const ok = await t.mutation(api.public.createSession, {
        userId: `${USER_ID}_${i}`,
        email: EMAIL,
        send,
      });
      expect(ok.ok).toBe(true);
    }
    const limited = await t.mutation(api.public.createSession, {
      userId: `${USER_ID}_overflow`,
      email: EMAIL,
      send,
    });
    expect(limited.ok).toBe(false);
    if (!limited.ok) {
      expect(limited.userError.error).toBe("RATE_LIMITED");
      expect(typeof limited.userError.retryAfterMs).toBe("number");
    }
  });

  test("throttles confirmation attempts per session", async () => {
    const t = setup();
    const { session } = await createSession(t);
    const wrong = "ZZZZZZZZ";

    // Capacity is 5 for the consume bucket; the 6th attempt on the same session
    // is rejected by the limiter (before the code is even checked).
    for (let i = 0; i < 5; i++) {
      await t.mutation(api.public.consumeSession, { session, code: wrong });
    }
    const limited = await t.mutation(api.public.consumeSession, {
      session,
      code: wrong,
    });
    expect(limited.valid).toBe(false);
    if (!limited.valid) {
      expect(limited.error).toBe("RATE_LIMITED");
      expect(typeof limited.retryAfterMs).toBe("number");
    }
  });
});
