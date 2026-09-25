import { convexTest } from "convex-test";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { exportJWK, exportPKCS8, generateKeyPair } from "jose";
import { api } from "./_generated/api.js";
import { registerCore } from "@convex-dev/auth/providers/testing/core";
import { registerPasswordProvider } from "@convex-dev/auth/providers/testing/password";
import { registerUsername } from "@convex-dev/auth/providers/testing/username";
import {
  BACKUP_CODE_COUNT,
  registerTotp,
  totp as totpCode,
} from "@convex-dev/auth/providers/testing/totp";
import schema from "./schema.js";

const modules = import.meta.glob("./**/*.ts");

const PASSWORD = "correct horse battery staple";
const PERIOD_MS = 30_000;
// A moment in the middle of a time step, so that a few milliseconds of test
// time never cross a step boundary.
const START = 1_700_000_015_000;

// The codes depend on the time. Only `Date` is faked, because convex-test
// uses the real timers.
beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(START);
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllEnvs();
});

const advance = (ms: number) => vi.setSystemTime(Date.now() + ms);

// The code the user's authenticator app shows for the secret right now.
const codeFor = (secret: string) =>
  totpCode({ secret, algorithm: "SHA-1", digits: 6, period: 30 }, Date.now());

async function setup() {
  const { publicKey, privateKey } = await generateKeyPair("RS256", {
    extractable: true,
  });
  vi.stubEnv("CONVEX_SITE_URL", "https://example.convex.site");
  vi.stubEnv("AUTH_PRIVATE_KEY", btoa(await exportPKCS8(privateKey)));
  vi.stubEnv(
    "AUTH_JWKS",
    JSON.stringify({
      keys: [
        { ...(await exportJWK(publicKey)), kid: "test-key", alg: "RS256" },
      ],
    }),
  );

  const t = convexTest(schema, modules);
  registerCore(t);
  registerPasswordProvider(t);
  registerUsername(t);
  registerTotp(t);
  return t;
}

/** Sign Alice up and return a test instance acting as her. */
async function signedInAlice() {
  const t = await setup();
  const up = await t.mutation(api.auth.signUpWithPassword, {
    username: "alice",
    password: PASSWORD,
  });
  if (up.status !== "complete") throw new Error("sign-up failed");
  return { t, alice: t.withIdentity({ subject: up.tokens.userId }) };
}

type Alice = Awaited<ReturnType<typeof signedInAlice>>["alice"];

/** Enroll Alice's authenticator, and move the clock past the confirming code. */
async function enroll(alice: Alice) {
  const started = await alice.mutation(api.auth.startTotpEnrollment, {
    accountName: "alice",
  });
  if (!started.success) throw new Error("start failed");
  const confirmed = await alice.mutation(api.auth.confirmTotpEnrollment, {
    code: await codeFor(started.secret),
  });
  if (!confirmed.success) throw new Error("confirm failed");
  advance(PERIOD_MS);
  return { secret: started.secret, backupCodes: confirmed.backupCodes };
}

describe("setupTotp", () => {
  test("a new user has no second factor", async () => {
    const { alice } = await signedInAlice();
    expect(await alice.query(api.auth.getTotpStatus)).toEqual({
      enabled: false,
      remainingBackupCodes: 0,
    });
  });

  test("a signed-out caller sees null and cannot enroll", async () => {
    const { t } = await signedInAlice();
    expect(await t.query(api.auth.getTotpStatus)).toBeNull();
    expect(
      await t.mutation(api.auth.startTotpEnrollment, { accountName: "x" }),
    ).toEqual({ success: false, userError: { error: "NOT_SIGNED_IN" } });
    expect(
      await t.mutation(api.auth.confirmTotpEnrollment, { code: "000000" }),
    ).toEqual({ success: false, userError: { error: "NOT_SIGNED_IN" } });
    expect(await t.mutation(api.auth.disableTotp, { code: "000000" })).toEqual({
      success: false,
      userError: { error: "NOT_SIGNED_IN" },
    });
    expect(
      await t.mutation(api.auth.regenerateBackupCodes, { code: "000000" }),
    ).toEqual({ success: false, userError: { error: "NOT_SIGNED_IN" } });
  });

  test("enrolling takes a start, a code, and hands out backup codes", async () => {
    const { alice } = await signedInAlice();
    const started = await alice.mutation(api.auth.startTotpEnrollment, {
      accountName: "alice",
    });
    expect(started).toEqual({
      success: true,
      secret: expect.stringMatching(/^[A-Z2-7]{32}$/),
      otpauthUri: expect.stringContaining(
        "otpauth://totp/Convex%20Auth%20v2%20Password%20Example:alice?",
      ),
    });
    expect(await alice.query(api.auth.getTotpStatus)).toMatchObject({
      enabled: false,
    });

    const { secret } = started as Extract<typeof started, { success: true }>;
    const confirmed = await alice.mutation(api.auth.confirmTotpEnrollment, {
      code: await codeFor(secret),
    });
    expect(confirmed).toEqual({
      success: true,
      backupCodes: expect.arrayContaining([expect.any(String)]),
    });
    expect(await alice.query(api.auth.getTotpStatus)).toEqual({
      enabled: true,
      remainingBackupCodes: BACKUP_CODE_COUNT,
    });
  });

  test("a wrong code leaves the enrollment pending", async () => {
    const { alice } = await signedInAlice();
    const started = await alice.mutation(api.auth.startTotpEnrollment, {
      accountName: "alice",
    });
    const { secret } = started as Extract<typeof started, { success: true }>;
    expect(
      await alice.mutation(api.auth.confirmTotpEnrollment, { code: "000000" }),
    ).toEqual({ success: false, userError: { error: "INVALID_CODE" } });
    expect(await alice.query(api.auth.getTotpStatus)).toMatchObject({
      enabled: false,
    });
    // The right code still confirms it.
    expect(
      await alice.mutation(api.auth.confirmTotpEnrollment, {
        code: await codeFor(secret),
      }),
    ).toMatchObject({ success: true });
  });

  test("an abandoned re-enrollment leaves the first authenticator in charge", async () => {
    const { t, alice } = await signedInAlice();
    const { secret } = await enroll(alice);
    // A second authenticator the user starts and never confirms.
    await alice.mutation(api.auth.startTotpEnrollment, {
      accountName: "alice",
    });
    expect(await alice.query(api.auth.getTotpStatus)).toMatchObject({
      enabled: true,
    });
    const held = await t.mutation(api.auth.signInWithPassword, {
      username: "alice",
      password: PASSWORD,
    });
    const { attemptToken } = held as Extract<
      typeof held,
      { status: "incomplete" }
    >;
    expect(
      await t.mutation(api.auth.verifyTotpForSignIn, {
        attemptToken,
        code: await codeFor(secret),
      }),
    ).toEqual({ success: true });
  });

  test("confirming without a started enrollment is refused", async () => {
    const { alice } = await signedInAlice();
    expect(
      await alice.mutation(api.auth.confirmTotpEnrollment, { code: "000000" }),
    ).toEqual({
      success: false,
      userError: { error: "NO_PENDING_ENROLLMENT" },
    });
  });

  test("an enrolled user's login asks for a code, and the code finishes it", async () => {
    const { t, alice } = await signedInAlice();
    const { secret } = await enroll(alice);
    const held = await t.mutation(api.auth.signInWithPassword, {
      username: "alice",
      password: PASSWORD,
    });
    expect(held).toMatchObject({
      status: "incomplete",
      requirements: ["totp"],
    });
    const { attemptToken } = held as Extract<
      typeof held,
      { status: "incomplete" }
    >;

    // What the app enrolled is what the sign-in step checks the code against.
    expect(
      await t.mutation(api.auth.verifyTotpForSignIn, {
        attemptToken,
        code: await codeFor(secret),
      }),
    ).toEqual({ success: true });
    expect(
      await t.mutation(api.auth.continueSignIn, { attemptToken }),
    ).toMatchObject({ status: "complete" });
  });

  test("turning it off takes a current code, and login no longer asks", async () => {
    const { t, alice } = await signedInAlice();
    const { secret } = await enroll(alice);

    expect(
      await alice.mutation(api.auth.disableTotp, { code: "000000" }),
    ).toEqual({ success: false, userError: { error: "INVALID_CODE" } });
    expect(await alice.query(api.auth.getTotpStatus)).toMatchObject({
      enabled: true,
    });

    expect(
      await alice.mutation(api.auth.disableTotp, {
        code: await codeFor(secret),
      }),
    ).toEqual({ success: true });
    expect(await alice.query(api.auth.getTotpStatus)).toEqual({
      enabled: false,
      remainingBackupCodes: 0,
    });
    expect(
      await t.mutation(api.auth.signInWithPassword, {
        username: "alice",
        password: PASSWORD,
      }),
    ).toMatchObject({ status: "complete" });
  });

  test("a backup code turns it off too", async () => {
    const { alice } = await signedInAlice();
    const { backupCodes } = await enroll(alice);
    expect(
      await alice.mutation(api.auth.disableTotp, {
        code: backupCodes[0],
        kind: "backup",
      }),
    ).toEqual({ success: true });
  });

  test("turning it off when it is off is refused", async () => {
    const { alice } = await signedInAlice();
    expect(
      await alice.mutation(api.auth.disableTotp, { code: "000000" }),
    ).toEqual({ success: false, userError: { error: "NOT_ENROLLED" } });
  });

  test("new backup codes take a current code and replace the old ones", async () => {
    const { alice } = await signedInAlice();
    const { secret, backupCodes } = await enroll(alice);

    expect(
      await alice.mutation(api.auth.regenerateBackupCodes, { code: "000000" }),
    ).toEqual({ success: false, userError: { error: "INVALID_CODE" } });

    const result = await alice.mutation(api.auth.regenerateBackupCodes, {
      code: await codeFor(secret),
    });
    expect(result).toEqual({
      success: true,
      backupCodes: expect.arrayContaining([expect.any(String)]),
    });
    const fresh = (result as Extract<typeof result, { success: true }>)
      .backupCodes;
    expect(fresh).toHaveLength(BACKUP_CODE_COUNT);
    expect(fresh).not.toEqual(backupCodes);

    // The old codes no longer turn the factor off; a new one does.
    expect(
      await alice.mutation(api.auth.disableTotp, {
        code: backupCodes[0],
        kind: "backup",
      }),
    ).toEqual({ success: false, userError: { error: "INVALID_CODE" } });
    expect(
      await alice.mutation(api.auth.disableTotp, {
        code: fresh[0],
        kind: "backup",
      }),
    ).toEqual({ success: true });
  });

  test("an old backup code buys a new set", async () => {
    const { alice } = await signedInAlice();
    const { backupCodes } = await enroll(alice);
    const result = await alice.mutation(api.auth.regenerateBackupCodes, {
      code: backupCodes[0],
      kind: "backup",
    });
    expect(result).toMatchObject({ success: true });
    expect(await alice.query(api.auth.getTotpStatus)).toMatchObject({
      remainingBackupCodes: BACKUP_CODE_COUNT,
    });
  });

  test("backup codes need an enrolled authenticator", async () => {
    const { alice } = await signedInAlice();
    expect(
      await alice.mutation(api.auth.regenerateBackupCodes, { code: "000000" }),
    ).toEqual({ success: false, userError: { error: "NOT_ENROLLED" } });
  });

  test("a user's right codes never run into the rate limit", async () => {
    // A session of trying the second factor out: sign in a few times, renew
    // the backup codes, then turn it off, all within a few minutes and all
    // with right codes. The rate limit is for wrong guesses, thus none of
    // this is throttled, however many right codes it takes.
    const { t, alice } = await signedInAlice();
    const { secret } = await enroll(alice);

    const signInWithCode = async () => {
      const held = await t.mutation(api.auth.signInWithPassword, {
        username: "alice",
        password: PASSWORD,
      });
      const { attemptToken } = held as Extract<
        typeof held,
        { status: "incomplete" }
      >;
      expect(
        await t.mutation(api.auth.verifyTotpForSignIn, {
          attemptToken,
          code: await codeFor(secret),
        }),
      ).toEqual({ success: true });
      expect(
        await t.mutation(api.auth.continueSignIn, { attemptToken }),
      ).toMatchObject({ status: "complete" });
      // A code works once; the next action needs the code of a later step.
      advance(PERIOD_MS);
    };

    for (let i = 0; i < 4; i++) {
      await signInWithCode();
    }
    expect(
      await alice.mutation(api.auth.regenerateBackupCodes, {
        code: await codeFor(secret),
      }),
    ).toMatchObject({ success: true });
    advance(PERIOD_MS);
    await signInWithCode();
    expect(
      await alice.mutation(api.auth.disableTotp, {
        code: await codeFor(secret),
      }),
    ).toEqual({ success: true });
  });
});
