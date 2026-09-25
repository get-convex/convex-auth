import { describe, expect, test } from "vitest";
import { api } from "./_generated/api.ts";
import { BACKUP_CODE_COUNT } from "./backupCodes.ts";
import { base32Encode } from "./totp.ts";
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

describe("regenerateBackupCodes", () => {
  test("replaces the backup codes for a current code", async () => {
    const t = setup();
    const { secret, backupCodes: old } = await enroll(t);
    await t.mutation(api.verification.verifyBackupCode, {
      userId: "alice",
      code: old[0],
    });
    expect(
      await t.query(api.enrollment.getStatus, { userId: "alice" }),
    ).toEqual({
      enabled: true,
      remainingBackupCodes: BACKUP_CODE_COUNT - 1,
    });

    const result = await t.mutation(api.management.regenerateBackupCodes, {
      userId: "alice",
      code: await codeFor(secret),
      kind: "totp",
    });
    expect(result.success).toBe(true);
    if (!result.success) throw new Error("unreachable");
    const fresh = result.backupCodes;
    expect(fresh).toHaveLength(BACKUP_CODE_COUNT);
    expect(fresh).not.toEqual(old);
    expect(
      await t.query(api.enrollment.getStatus, { userId: "alice" }),
    ).toEqual({
      enabled: true,
      remainingBackupCodes: BACKUP_CODE_COUNT,
    });

    expect(
      await t.mutation(api.verification.verifyBackupCode, {
        userId: "alice",
        code: old[1],
      }),
    ).toEqual({ success: false, userError: { error: "INVALID_CODE" } });
    expect(
      await t.mutation(api.verification.verifyBackupCode, {
        userId: "alice",
        code: fresh[1],
      }),
    ).toEqual({ success: true, remainingBackupCodes: BACKUP_CODE_COUNT - 1 });
  });

  test("an old backup code buys the new set, and is spent with the rest", async () => {
    const t = setup();
    const { backupCodes: old } = await enroll(t);
    const result = await t.mutation(api.management.regenerateBackupCodes, {
      userId: "alice",
      code: old[0],
      kind: "backup",
    });
    expect(result).toMatchObject({ success: true });
    expect(
      await t.query(api.enrollment.getStatus, { userId: "alice" }),
    ).toMatchObject({ remainingBackupCodes: BACKUP_CODE_COUNT });
    expect(
      await t.mutation(api.verification.verifyBackupCode, {
        userId: "alice",
        code: old[0],
      }),
    ).toEqual({ success: false, userError: { error: "INVALID_CODE" } });
  });

  test("refuses a wrong code and keeps the old set", async () => {
    const t = setup();
    const { backupCodes: old } = await enroll(t);
    expect(
      await t.mutation(api.management.regenerateBackupCodes, {
        userId: "alice",
        code: "000000",
        kind: "totp",
      }),
    ).toEqual({ success: false, userError: { error: "INVALID_CODE" } });
    expect(
      await t.mutation(api.management.regenerateBackupCodes, {
        userId: "alice",
        code: "aaaaa-aaaaa",
        kind: "backup",
      }),
    ).toEqual({ success: false, userError: { error: "INVALID_CODE" } });
    expect(
      await t.mutation(api.verification.verifyBackupCode, {
        userId: "alice",
        code: old[0],
      }),
    ).toEqual({ success: true, remainingBackupCodes: BACKUP_CODE_COUNT - 1 });
  });

  test("the code that bought a set cannot be reused", async () => {
    const t = setup();
    const { secret } = await enroll(t);
    const code = await codeFor(secret);
    expect(
      await t.mutation(api.management.regenerateBackupCodes, {
        userId: "alice",
        code,
        kind: "totp",
      }),
    ).toMatchObject({ success: true });
    expect(
      await t.mutation(api.verification.verifyCode, { userId: "alice", code }),
    ).toEqual({ success: false, userError: { error: "INVALID_CODE" } });
  });

  test("shares the rate limit of verifyCode, and its right codes cost nothing", async () => {
    const t = setup();
    const { secret } = await enroll(t);
    for (let i = 0; i < 5; i++) {
      expect(
        await t.mutation(api.management.regenerateBackupCodes, {
          userId: "alice",
          code: "000000",
          kind: "totp",
        }),
      ).toEqual({ success: false, userError: { error: "INVALID_CODE" } });
    }
    expect(
      await t.mutation(api.management.regenerateBackupCodes, {
        userId: "alice",
        code: await codeFor(secret),
        kind: "totp",
      }),
    ).toEqual({
      success: false,
      userError: { error: "RATE_LIMITED", retryAfterMs: expect.any(Number) },
    });
    expect(
      await t.mutation(api.verification.verifyCode, {
        userId: "alice",
        code: await codeFor(secret),
      }),
    ).toMatchObject({ userError: { error: "RATE_LIMITED" } });

    // One try refills after five minutes: a right code uses none of it.
    advance(5 * 60 * 1000);
    expect(
      await t.mutation(api.management.regenerateBackupCodes, {
        userId: "alice",
        code: await codeFor(secret),
        kind: "totp",
      }),
    ).toMatchObject({ success: true });
    advance(PERIOD_MS);
    expect(
      await t.mutation(api.verification.verifyCode, {
        userId: "alice",
        code: await codeFor(secret),
      }),
    ).toEqual({ success: true });
  });

  test("refuses a user with no active secret", async () => {
    const t = setup();
    expect(
      await t.mutation(api.management.regenerateBackupCodes, {
        userId: "nobody",
        code: "000000",
        kind: "totp",
      }),
    ).toEqual({ success: false, userError: { error: "NOT_ENROLLED" } });

    // A pending secret is not active.
    const { secret } = await t.mutation(api.enrollment.createTotp, {
      userId: "alice",
      ...ENROLLMENT,
    });
    expect(
      await t.mutation(api.management.regenerateBackupCodes, {
        userId: "alice",
        code: await codeFor(secret),
        kind: "totp",
      }),
    ).toEqual({ success: false, userError: { error: "NOT_ENROLLED" } });
    expect(
      await t.query(api.enrollment.getStatus, { userId: "alice" }),
    ).toMatchObject({ remainingBackupCodes: 0 });
  });
});

describe("deleteTotp", () => {
  test("deletes the secrets and the backup codes for a current code", async () => {
    const t = setup();
    const { secret } = await enroll(t);
    await t.mutation(api.enrollment.createTotp, {
      userId: "alice",
      ...ENROLLMENT,
    });

    expect(
      await t.mutation(api.management.deleteTotp, {
        userId: "alice",
        code: await codeFor(secret),
        kind: "totp",
      }),
    ).toEqual({ success: true });
    expect(
      await t.query(api.enrollment.getStatus, { userId: "alice" }),
    ).toEqual({
      enabled: false,
      remainingBackupCodes: 0,
    });
    const [secrets, backupCodes] = await t.run(async (ctx) => [
      await ctx.db.query("totpSecrets").collect(),
      await ctx.db.query("backupCodes").collect(),
    ]);
    expect(secrets).toEqual([]);
    expect(backupCodes).toEqual([]);
    await expect(
      t.mutation(api.verification.verifyCode, {
        userId: "alice",
        code: "123456",
      }),
    ).rejects.toThrow(/No active TOTP secret/);
  });

  test("a backup code turns it off too", async () => {
    const t = setup();
    const { backupCodes } = await enroll(t);
    expect(
      await t.mutation(api.management.deleteTotp, {
        userId: "alice",
        code: backupCodes[0],
        kind: "backup",
      }),
    ).toEqual({ success: true });
    expect(
      await t.query(api.enrollment.getStatus, { userId: "alice" }),
    ).toMatchObject({ enabled: false, remainingBackupCodes: 0 });
  });

  test("refuses a wrong code and keeps the factor on", async () => {
    const t = setup();
    const { secret, backupCodes } = await enroll(t);
    expect(
      await t.mutation(api.management.deleteTotp, {
        userId: "alice",
        code: "000000",
        kind: "totp",
      }),
    ).toEqual({ success: false, userError: { error: "INVALID_CODE" } });
    expect(
      await t.mutation(api.management.deleteTotp, {
        userId: "alice",
        code: backupCodes[0],
        kind: "totp",
      }),
    ).toEqual({ success: false, userError: { error: "INVALID_CODE" } });
    expect(
      await t.mutation(api.management.deleteTotp, {
        userId: "alice",
        code: await codeFor(secret),
        kind: "backup",
      }),
    ).toEqual({ success: false, userError: { error: "INVALID_CODE" } });
    expect(
      await t.query(api.enrollment.getStatus, { userId: "alice" }),
    ).toEqual({
      enabled: true,
      remainingBackupCodes: BACKUP_CODE_COUNT,
    });
  });

  test("wrong codes count against the shared rate limit", async () => {
    const t = setup();
    const { secret } = await enroll(t);
    for (let i = 0; i < 3; i++) {
      await t.mutation(api.management.deleteTotp, {
        userId: "alice",
        code: "000000",
        kind: "totp",
      });
    }
    for (let i = 0; i < 2; i++) {
      await t.mutation(api.verification.verifyCode, {
        userId: "alice",
        code: "000000",
      });
    }
    expect(
      await t.mutation(api.management.deleteTotp, {
        userId: "alice",
        code: await codeFor(secret),
        kind: "totp",
      }),
    ).toEqual({
      success: false,
      userError: { error: "RATE_LIMITED", retryAfterMs: expect.any(Number) },
    });
    expect(
      await t.query(api.enrollment.getStatus, { userId: "alice" }),
    ).toMatchObject({ enabled: true });
  });

  test("refuses a user with no active secret", async () => {
    const t = setup();
    expect(
      await t.mutation(api.management.deleteTotp, {
        userId: "nobody",
        code: "000000",
        kind: "totp",
      }),
    ).toEqual({ success: false, userError: { error: "NOT_ENROLLED" } });

    // A pending secret is not active, and stays: it grants nothing, and the
    // next `createTotp` replaces it.
    const { secret } = await t.mutation(api.enrollment.createTotp, {
      userId: "alice",
      ...ENROLLMENT,
    });
    expect(
      await t.mutation(api.management.deleteTotp, {
        userId: "alice",
        code: await codeFor(secret),
        kind: "totp",
      }),
    ).toEqual({ success: false, userError: { error: "NOT_ENROLLED" } });
    const rows = await t.run((ctx) => ctx.db.query("totpSecrets").collect());
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ status: "pending" });
    expect(base32Encode(new Uint8Array(rows[0].secret))).toBe(secret);
  });

  test("deletes only the data of the given user", async () => {
    const t = setup();
    const alice = await enroll(t, "alice");
    const bob = await enroll(t, "bob");
    expect(
      await t.mutation(api.management.deleteTotp, {
        userId: "alice",
        code: await codeFor(alice.secret),
        kind: "totp",
      }),
    ).toEqual({ success: true });
    expect(await t.query(api.enrollment.getStatus, { userId: "bob" })).toEqual({
      enabled: true,
      remainingBackupCodes: BACKUP_CODE_COUNT,
    });
    expect(
      await t.mutation(api.verification.verifyCode, {
        userId: "bob",
        code: await codeFor(bob.secret),
      }),
    ).toEqual({ success: true });
  });
});

describe("deleteUser", () => {
  test("deletes the secrets and the backup codes without a code", async () => {
    const t = setup();
    await enroll(t);
    await t.mutation(api.enrollment.createTotp, {
      userId: "alice",
      ...ENROLLMENT,
    });

    expect(
      await t.mutation(api.management.deleteUser, { userId: "alice" }),
    ).toBeNull();
    expect(
      await t.query(api.enrollment.getStatus, { userId: "alice" }),
    ).toEqual({
      enabled: false,
      remainingBackupCodes: 0,
    });
    const [secrets, backupCodes] = await t.run(async (ctx) => [
      await ctx.db.query("totpSecrets").collect(),
      await ctx.db.query("backupCodes").collect(),
    ]);
    expect(secrets).toEqual([]);
    expect(backupCodes).toEqual([]);
    await expect(
      t.mutation(api.verification.verifyCode, {
        userId: "alice",
        code: "123456",
      }),
    ).rejects.toThrow(/No active TOTP secret/);
  });

  test("is idempotent, and safe for a user who never enrolled", async () => {
    const t = setup();
    expect(
      await t.mutation(api.management.deleteUser, { userId: "nobody" }),
    ).toBeNull();
    await enroll(t);
    await t.mutation(api.management.deleteUser, { userId: "alice" });
    expect(
      await t.mutation(api.management.deleteUser, { userId: "alice" }),
    ).toBeNull();
    expect(
      await t.query(api.enrollment.getStatus, { userId: "alice" }),
    ).toEqual({
      enabled: false,
      remainingBackupCodes: 0,
    });
  });

  test("deletes only the data of the given user", async () => {
    const t = setup();
    await enroll(t, "alice");
    const bob = await enroll(t, "bob");
    await t.mutation(api.management.deleteUser, { userId: "alice" });
    expect(await t.query(api.enrollment.getStatus, { userId: "bob" })).toEqual({
      enabled: true,
      remainingBackupCodes: BACKUP_CODE_COUNT,
    });
    expect(
      await t.mutation(api.verification.verifyCode, {
        userId: "bob",
        code: await codeFor(bob.secret),
      }),
    ).toEqual({ success: true });
  });
});
