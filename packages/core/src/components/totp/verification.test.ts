import { type TestConvex } from "convex-test";
import { describe, expect, test } from "vitest";
import { api } from "./_generated/api.ts";
import schema from "./schema.ts";
import { SIGN_IN_VERIFICATION_TTL_MS } from "./verification.ts";
import { BACKUP_CODE_COUNT } from "./backupCodes.ts";
import {
  ENROLLMENT,
  PERIOD_MS,
  advance,
  codeFor,
  controlClock,
  enroll,
  setup,
} from "../totpTestSetup.ts";

controlClock();

describe("verifyCode", () => {
  test("accepts the current code", async () => {
    const t = setup();
    const { secret } = await enroll(t);
    expect(
      await t.mutation(api.verification.verifyCode, {
        userId: "alice",
        code: await codeFor(secret),
      }),
    ).toEqual({ success: true });
  });

  test("accepts a code with a space in the middle", async () => {
    const t = setup();
    const { secret } = await enroll(t);
    const code = await codeFor(secret);
    expect(
      await t.mutation(api.verification.verifyCode, {
        userId: "alice",
        code: `${code.slice(0, 3)} ${code.slice(3)}`,
      }),
    ).toEqual({ success: true });
  });

  test("tolerates one step of clock drift in each direction", async () => {
    const t = setup();
    const { secret } = await enroll(t);
    // Two steps after the confirmation, so that the previous step is not the
    // one the confirmation used.
    advance(PERIOD_MS);
    expect(
      await t.mutation(api.verification.verifyCode, {
        userId: "alice",
        code: await codeFor(secret, Date.now() - PERIOD_MS),
      }),
    ).toEqual({ success: true });

    const t2 = setup();
    const second = await enroll(t2);
    expect(
      await t2.mutation(api.verification.verifyCode, {
        userId: "alice",
        code: await codeFor(second.secret, Date.now() + PERIOD_MS),
      }),
    ).toEqual({ success: true });
  });

  test("rejects a code from outside the window", async () => {
    const t = setup();
    const { secret } = await enroll(t);
    advance(2 * PERIOD_MS);
    for (const offset of [-2 * PERIOD_MS, 2 * PERIOD_MS]) {
      expect(
        await t.mutation(api.verification.verifyCode, {
          userId: "alice",
          code: await codeFor(secret, Date.now() + offset),
        }),
        `offset ${offset}`,
      ).toEqual({ success: false, userError: { error: "INVALID_CODE" } });
    }
  });

  test("rejects a code that was already used", async () => {
    const t = setup();
    const { secret } = await enroll(t);
    const code = await codeFor(secret);
    expect(
      await t.mutation(api.verification.verifyCode, { userId: "alice", code }),
    ).toEqual({ success: true });
    expect(
      await t.mutation(api.verification.verifyCode, { userId: "alice", code }),
    ).toEqual({ success: false, userError: { error: "INVALID_CODE" } });
  });

  test("rejects the code of an earlier step after a later one was used", async () => {
    const t = setup();
    const { secret } = await enroll(t);
    // The next step's code is within the window and is accepted first.
    expect(
      await t.mutation(api.verification.verifyCode, {
        userId: "alice",
        code: await codeFor(secret, Date.now() + PERIOD_MS),
      }),
    ).toEqual({ success: true });
    expect(
      await t.mutation(api.verification.verifyCode, {
        userId: "alice",
        code: await codeFor(secret),
      }),
    ).toEqual({ success: false, userError: { error: "INVALID_CODE" } });
  });

  test("rejects a malformed code", async () => {
    const t = setup();
    await enroll(t);
    for (const code of ["", "12345", "1234567", "abcdef", "12345a"]) {
      expect(
        await t.mutation(api.verification.verifyCode, {
          userId: "alice",
          code,
        }),
        JSON.stringify(code),
      ).toEqual({ success: false, userError: { error: "INVALID_CODE" } });
    }
  });

  test("rate limits after five attempts, and refills over time", async () => {
    const t = setup();
    const { secret } = await enroll(t);
    for (let i = 0; i < 5; i++) {
      expect(
        await t.mutation(api.verification.verifyCode, {
          userId: "alice",
          code: "000000",
        }),
      ).toEqual({ success: false, userError: { error: "INVALID_CODE" } });
    }
    const limited = await t.mutation(api.verification.verifyCode, {
      userId: "alice",
      code: await codeFor(secret),
    });
    expect(limited).toMatchObject({
      success: false,
      userError: { error: "RATE_LIMITED" },
    });
    if (limited.success || limited.userError.error !== "RATE_LIMITED") {
      throw new Error("unreachable");
    }
    expect(limited.userError.retryAfterMs).toBeGreaterThan(0);
    expect(limited.userError.retryAfterMs).toBeLessThanOrEqual(5 * 60 * 1000);

    // The bucket refills one attempt every five minutes.
    advance(limited.userError.retryAfterMs);
    expect(
      await t.mutation(api.verification.verifyCode, {
        userId: "alice",
        code: await codeFor(secret),
      }),
    ).toEqual({ success: true });
  });

  test("rate limits each user separately", async () => {
    const t = setup();
    await enroll(t, "alice");
    const bob = await enroll(t, "bob");
    for (let i = 0; i < 5; i++) {
      await t.mutation(api.verification.verifyCode, {
        userId: "alice",
        code: "000000",
      });
    }
    expect(
      await t.mutation(api.verification.verifyCode, {
        userId: "bob",
        code: await codeFor(bob.secret),
      }),
    ).toEqual({ success: true });
  });

  test("right codes are not counted against the rate limit", async () => {
    const t = setup();
    const { secret } = await enroll(t);
    // More right codes than the bucket holds, one per time step since a
    // code works once.
    for (let i = 0; i < 7; i++) {
      expect(
        await t.mutation(api.verification.verifyCode, {
          userId: "alice",
          code: await codeFor(secret),
        }),
        `right code ${i}`,
      ).toEqual({ success: true });
      advance(PERIOD_MS);
    }
    // The full budget of wrong guesses is still there.
    for (let i = 0; i < 5; i++) {
      expect(
        await t.mutation(api.verification.verifyCode, {
          userId: "alice",
          code: "000000",
        }),
        `wrong code ${i}`,
      ).toEqual({ success: false, userError: { error: "INVALID_CODE" } });
    }
    expect(
      await t.mutation(api.verification.verifyCode, {
        userId: "alice",
        code: "000000",
      }),
    ).toMatchObject({ success: false, userError: { error: "RATE_LIMITED" } });
  });

  test("a right code does not refund earlier wrong guesses", async () => {
    const t = setup();
    const { secret } = await enroll(t);
    for (let i = 0; i < 4; i++) {
      await t.mutation(api.verification.verifyCode, {
        userId: "alice",
        code: "000000",
      });
    }
    expect(
      await t.mutation(api.verification.verifyCode, {
        userId: "alice",
        code: await codeFor(secret),
      }),
    ).toEqual({ success: true });
    // One guess was left before the right code, and one is left after it.
    expect(
      await t.mutation(api.verification.verifyCode, {
        userId: "alice",
        code: "000000",
      }),
    ).toEqual({ success: false, userError: { error: "INVALID_CODE" } });
    expect(
      await t.mutation(api.verification.verifyCode, {
        userId: "alice",
        code: "000000",
      }),
    ).toMatchObject({ success: false, userError: { error: "RATE_LIMITED" } });
  });

  test("throws when the user has no active secret", async () => {
    const t = setup();
    await expect(
      t.mutation(api.verification.verifyCode, {
        userId: "nobody",
        code: "123456",
      }),
    ).rejects.toThrow(/No active TOTP secret/);

    // A pending secret is not active.
    const { secret } = await t.mutation(api.enrollment.createTotp, {
      userId: "alice",
      ...ENROLLMENT,
    });
    await expect(
      t.mutation(api.verification.verifyCode, {
        userId: "alice",
        code: await codeFor(secret),
      }),
    ).rejects.toThrow(/No active TOTP secret/);
  });
});

describe("verifyBackupCode", () => {
  test("accepts a backup code once", async () => {
    const t = setup();
    const { backupCodes } = await enroll(t);
    expect(
      await t.mutation(api.verification.verifyBackupCode, {
        userId: "alice",
        code: backupCodes[3],
      }),
    ).toEqual({ success: true, remainingBackupCodes: BACKUP_CODE_COUNT - 1 });
    expect(
      await t.mutation(api.verification.verifyBackupCode, {
        userId: "alice",
        code: backupCodes[3],
      }),
    ).toEqual({ success: false, userError: { error: "INVALID_CODE" } });
    expect(
      await t.query(api.enrollment.getStatus, { userId: "alice" }),
    ).toEqual({
      enabled: true,
      remainingBackupCodes: BACKUP_CODE_COUNT - 1,
    });
  });

  test("ignores the case, the hyphen and spaces", async () => {
    const t = setup();
    const { backupCodes } = await enroll(t);
    const [a, b, c] = backupCodes;
    expect(
      await t.mutation(api.verification.verifyBackupCode, {
        userId: "alice",
        code: a.toUpperCase(),
      }),
    ).toMatchObject({ success: true });
    expect(
      await t.mutation(api.verification.verifyBackupCode, {
        userId: "alice",
        code: b.replace("-", ""),
      }),
    ).toMatchObject({ success: true });
    expect(
      await t.mutation(api.verification.verifyBackupCode, {
        userId: "alice",
        code: ` ${c.replace("-", " ")} `,
      }),
    ).toMatchObject({ success: true });
  });

  test("rejects an unknown code", async () => {
    const t = setup();
    await enroll(t);
    expect(
      await t.mutation(api.verification.verifyBackupCode, {
        userId: "alice",
        code: "00000-00000",
      }),
    ).toEqual({ success: false, userError: { error: "INVALID_CODE" } });
  });

  test("rejects the backup code of a different user", async () => {
    const t = setup();
    await enroll(t, "alice");
    const bob = await enroll(t, "bob");
    expect(
      await t.mutation(api.verification.verifyBackupCode, {
        userId: "alice",
        code: bob.backupCodes[0],
      }),
    ).toEqual({ success: false, userError: { error: "INVALID_CODE" } });
  });

  test("shares the rate limit with verifyCode", async () => {
    const t = setup();
    const { backupCodes } = await enroll(t);
    for (let i = 0; i < 5; i++) {
      await t.mutation(api.verification.verifyCode, {
        userId: "alice",
        code: "000000",
      });
    }
    expect(
      await t.mutation(api.verification.verifyBackupCode, {
        userId: "alice",
        code: backupCodes[0],
      }),
    ).toMatchObject({
      success: false,
      userError: { error: "RATE_LIMITED" },
    });
  });

  test("counts wrong backup codes, and not right ones, against the shared limit", async () => {
    const t = setup();
    const { secret, backupCodes } = await enroll(t);
    // More right backup codes than the bucket holds.
    for (let i = 0; i < 6; i++) {
      expect(
        await t.mutation(api.verification.verifyBackupCode, {
          userId: "alice",
          code: backupCodes[i],
        }),
        `right backup code ${i}`,
      ).toMatchObject({ success: true });
    }
    // Wrong backup codes use up the same budget as wrong TOTP codes.
    for (let i = 0; i < 5; i++) {
      expect(
        await t.mutation(api.verification.verifyBackupCode, {
          userId: "alice",
          code: "00000-00000",
        }),
        `wrong backup code ${i}`,
      ).toEqual({ success: false, userError: { error: "INVALID_CODE" } });
    }
    expect(
      await t.mutation(api.verification.verifyCode, {
        userId: "alice",
        code: await codeFor(secret),
      }),
    ).toMatchObject({ success: false, userError: { error: "RATE_LIMITED" } });
  });

  test("throws when the user has no active secret", async () => {
    const t = setup();
    await expect(
      t.mutation(api.verification.verifyBackupCode, {
        userId: "nobody",
        code: "00000-00000",
      }),
    ).rejects.toThrow(/No active TOTP secret/);
  });
});

describe("checkSignIn", () => {
  const ATTEMPT = "attempt-1";

  /** Whether the attempt has settled its TOTP, as the auth core asks it. */
  async function satisfied(
    t: TestConvex<typeof schema>,
    userId = "alice",
    attemptId = ATTEMPT,
  ) {
    return await t.query(api.verification.checkSignIn, { userId, attemptId });
  }

  test("an enrolled user owes a code until the attempt verifies one", async () => {
    const t = setup();
    const { secret } = await enroll(t);
    expect(await satisfied(t)).toBe(false);

    expect(
      await t.mutation(api.verification.verifyCode, {
        userId: "alice",
        code: await codeFor(secret),
        attemptId: ATTEMPT,
      }),
    ).toEqual({ success: true });
    expect(await satisfied(t)).toBe(true);
  });

  test("a verified backup code satisfies the attempt too", async () => {
    const t = setup();
    const { backupCodes } = await enroll(t);
    expect(
      await t.mutation(api.verification.verifyBackupCode, {
        userId: "alice",
        code: backupCodes[0],
        attemptId: ATTEMPT,
      }),
    ).toMatchObject({ success: true });
    expect(await satisfied(t)).toBe(true);
  });

  test("a user who is not enrolled owes nothing", async () => {
    const t = setup();
    expect(await satisfied(t)).toBe(true);
    // A started enrollment grants nothing until it is confirmed, thus it asks
    // for nothing at sign-in either.
    await t.mutation(api.enrollment.createTotp, {
      userId: "alice",
      ...ENROLLMENT,
    });
    expect(await satisfied(t)).toBe(true);
  });

  test("a user whose TOTP was turned off owes nothing", async () => {
    const t = setup();
    const { secret } = await enroll(t);
    expect(
      await t.mutation(api.management.deleteTotp, {
        userId: "alice",
        code: await codeFor(secret),
        kind: "totp",
      }),
    ).toEqual({ success: true });
    expect(await satisfied(t)).toBe(true);
  });

  test("a deleted user owes nothing", async () => {
    const t = setup();
    await enroll(t);
    await t.mutation(api.management.deleteUser, { userId: "alice" });
    expect(await satisfied(t)).toBe(true);
  });

  test("a rejected code marks nothing", async () => {
    const t = setup();
    await enroll(t);
    expect(
      await t.mutation(api.verification.verifyCode, {
        userId: "alice",
        code: "000000",
        attemptId: ATTEMPT,
      }),
    ).toEqual({ success: false, userError: { error: "INVALID_CODE" } });
    expect(
      await t.mutation(api.verification.verifyBackupCode, {
        userId: "alice",
        code: "00000-00000",
        attemptId: ATTEMPT,
      }),
    ).toEqual({ success: false, userError: { error: "INVALID_CODE" } });
    expect(await satisfied(t)).toBe(false);
    expect(
      await t.run((ctx) => ctx.db.query("signInVerifications").collect()),
    ).toHaveLength(0);
  });

  test("a verification without an attempt id marks nothing", async () => {
    // A re-authentication before a sensitive action, for instance: the
    // code checks out, but no sign-in attempt is involved.
    const t = setup();
    const { secret } = await enroll(t);
    expect(
      await t.mutation(api.verification.verifyCode, {
        userId: "alice",
        code: await codeFor(secret),
      }),
    ).toEqual({ success: true });
    expect(
      await t.run((ctx) => ctx.db.query("signInVerifications").collect()),
    ).toHaveLength(0);
    expect(await satisfied(t)).toBe(false);
  });

  test("the attempt of one user is not satisfied by the code of another", async () => {
    const t = setup();
    const { secret } = await enroll(t);
    await enroll(t, "bob");
    await t.mutation(api.verification.verifyCode, {
      userId: "alice",
      code: await codeFor(secret),
      attemptId: ATTEMPT,
    });
    // Same attempt id, other user: still owed.
    expect(await satisfied(t, "bob")).toBe(false);
    // Same user, other attempt: still owed.
    expect(await satisfied(t, "alice", "attempt-2")).toBe(false);
  });

  test("a second verification for the same attempt keeps one record", async () => {
    const t = setup();
    const { secret, backupCodes } = await enroll(t);
    await t.mutation(api.verification.verifyBackupCode, {
      userId: "alice",
      code: backupCodes[0],
      attemptId: ATTEMPT,
    });
    await t.mutation(api.verification.verifyCode, {
      userId: "alice",
      code: await codeFor(secret),
      attemptId: ATTEMPT,
    });
    expect(
      await t.run((ctx) => ctx.db.query("signInVerifications").collect()),
    ).toHaveLength(1);
    expect(await satisfied(t)).toBe(true);
  });

  test("a later verification prunes the stale records, and only those", async () => {
    const t = setup();
    const { secret } = await enroll(t);
    await enroll(t, "bob");
    // Alice verifies and abandons her attempt.
    await t.mutation(api.verification.verifyCode, {
      userId: "alice",
      code: await codeFor(secret),
      attemptId: "abandoned",
    });
    // Just under the TTL later, a fresh verification keeps the record...
    advance(SIGN_IN_VERIFICATION_TTL_MS - PERIOD_MS);
    await t.mutation(api.verification.verifyCode, {
      userId: "alice",
      code: await codeFor(secret),
      attemptId: "recent",
    });
    expect(await satisfied(t, "alice", "abandoned")).toBe(true);
    // ...and past the TTL, the next one sweeps it and leaves the recent one.
    advance(2 * PERIOD_MS);
    await t.mutation(api.verification.verifyCode, {
      userId: "alice",
      code: await codeFor(secret),
      attemptId: "newest",
    });
    const remaining = await t.run((ctx) =>
      ctx.db.query("signInVerifications").collect(),
    );
    expect(remaining.map((r) => r.attemptId).sort()).toEqual([
      "newest",
      "recent",
    ]);
    // The swept record's attempt owes a code again, which is harmless: the
    // auth core never reuses an attempt id, so nothing continues it.
    expect(await satisfied(t, "alice", "abandoned")).toBe(false);
  });
});
