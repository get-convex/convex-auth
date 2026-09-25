import { convexTest } from "convex-test";
import { afterEach, describe, expect, test, vi } from "vitest";
import { exportJWK, exportPKCS8, generateKeyPair } from "jose";
import { api, components } from "./_generated/api.js";
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

const PASSWORD = "correct horse battery staple"; // 28 chars, valid

async function setup() {
  // The core signs JWTs from these env vars (see core/public.ts). Mint a real
  // RS256 key pair for each test and stub the env so Vitest can reset it.
  const { publicKey, privateKey } = await generateKeyPair("RS256", {
    extractable: true,
  });
  const pkcs8 = await exportPKCS8(privateKey);
  const publicJwk = await exportJWK(publicKey);

  vi.stubEnv("CONVEX_SITE_URL", "https://example.convex.site");
  vi.stubEnv("AUTH_PRIVATE_KEY", btoa(pkcs8));
  vi.stubEnv(
    "AUTH_JWKS",
    JSON.stringify({
      keys: [{ ...publicJwk, kid: "test-key", alg: "RS256", use: "sig" }],
    }),
  );

  const t = convexTest(schema, modules);
  registerCore(t);
  registerPasswordProvider(t);
  registerUsername(t);
  registerTotp(t);
  return t;
}

afterEach(() => {
  vi.unstubAllEnvs();
});

const signUp = (
  t: Awaited<ReturnType<typeof setup>>,
  username: string,
  password: string,
) => t.mutation(api.auth.signUpWithPassword, { username, password });

const signIn = (
  t: Awaited<ReturnType<typeof setup>>,
  username: string,
  password: string,
) => t.mutation(api.auth.signInWithPassword, { username, password });

const asUser = (t: Awaited<ReturnType<typeof setup>>, userId: string) =>
  t.withIdentity({ subject: userId });

type PasswordResult =
  Awaited<ReturnType<typeof signUp>> | Awaited<ReturnType<typeof signIn>>;
type PasswordSuccess = Extract<PasswordResult, { status: "complete" }>;

describe("setupUsernamePassword", () => {
  test("signs up a new user and returns a session", async () => {
    const t = await setup();
    const result = await signUp(t, "alice", PASSWORD);
    expect(result).toEqual({
      status: "complete",
      tokens: {
        accessToken: expect.any(String),
        accessTokenExpiresAt: expect.any(Number),
        refreshToken: expect.any(String),
        refreshTokenExpiresAt: expect.any(Number),
        userId: expect.any(String),
      },
    });
  });

  test("signs in with the correct password", async () => {
    const t = await setup();
    const up = await signUp(t, "alice", PASSWORD);
    const inResult = await signIn(t, "alice", PASSWORD);
    expect(up).toEqual({
      status: "complete",
      tokens: {
        accessToken: expect.any(String),
        accessTokenExpiresAt: expect.any(Number),
        refreshToken: expect.any(String),
        refreshTokenExpiresAt: expect.any(Number),
        userId: expect.any(String),
      },
    });
    expect(inResult).toEqual({
      status: "complete",
      tokens: {
        accessToken: expect.any(String),
        accessTokenExpiresAt: expect.any(Number),
        refreshToken: expect.any(String),
        refreshTokenExpiresAt: expect.any(Number),
        userId: expect.any(String),
      },
    });
    // Same identity → same app user id.
    expect((inResult as PasswordSuccess).tokens.userId).toBe(
      (up as PasswordSuccess).tokens.userId,
    );
  });

  test("two users get distinct accounts and sessions", async () => {
    const t = await setup();
    const alice = await signUp(t, "alice", PASSWORD);
    const bob = await signUp(t, "bob", "different horse battery staple");
    expect(alice).toMatchObject({ status: "complete" });
    expect(bob).toMatchObject({ status: "complete" });
    expect((bob as PasswordSuccess).tokens.userId).not.toBe(
      (alice as PasswordSuccess).tokens.userId,
    );

    // Each user signs in as themselves, not as the first user.
    const aliceIn = await signIn(t, "alice", PASSWORD);
    const bobIn = await signIn(t, "bob", "different horse battery staple");
    expect((aliceIn as PasswordSuccess).tokens.userId).toBe(
      (alice as PasswordSuccess).tokens.userId,
    );
    expect((bobIn as PasswordSuccess).tokens.userId).toBe(
      (bob as PasswordSuccess).tokens.userId,
    );
  });

  test("rejects a wrong password with INVALID_CREDENTIALS", async () => {
    const t = await setup();
    await signUp(t, "alice", PASSWORD);
    const result = await signIn(t, "alice", "wrong horse battery staple");
    expect(result).toEqual({
      status: "error",
      userError: { error: "INVALID_CREDENTIALS" },
    });
  });

  test("rejects an unknown username with USER_NOT_FOUND", async () => {
    const t = await setup();
    const result = await signIn(t, "nobody", PASSWORD);
    expect(result).toEqual({
      status: "error",
      userError: { error: "USER_NOT_FOUND" },
    });
  });

  test("rejects signing up a taken username", async () => {
    const t = await setup();
    await signUp(t, "alice", PASSWORD);
    const result = await signUp(t, "alice", PASSWORD);
    expect(result).toEqual({
      status: "error",
      userError: { error: "USERNAME_TAKEN" },
    });
  });

  test("usernames are case-insensitive", async () => {
    const t = await setup();
    const up = await signUp(t, "Alice", PASSWORD);
    expect(up).toEqual({
      status: "complete",
      tokens: {
        accessToken: expect.any(String),
        accessTokenExpiresAt: expect.any(Number),
        refreshToken: expect.any(String),
        refreshTokenExpiresAt: expect.any(Number),
        userId: expect.any(String),
      },
    });

    // A different casing is treated as the same account for both sign-in...
    const inResult = await signIn(t, "ALICE", PASSWORD);
    expect(inResult).toEqual({
      status: "complete",
      tokens: {
        accessToken: expect.any(String),
        accessTokenExpiresAt: expect.any(Number),
        refreshToken: expect.any(String),
        refreshTokenExpiresAt: expect.any(Number),
        userId: expect.any(String),
      },
    });
    expect((inResult as PasswordSuccess).tokens.userId).toBe(
      (up as PasswordSuccess).tokens.userId,
    );

    // ...and the taken-username check.
    const dup = await signUp(t, "alice", PASSWORD);
    expect(dup).toEqual({
      status: "error",
      userError: { error: "USERNAME_TAKEN" },
    });
  });

  test("rejects an empty username at sign-up", async () => {
    const t = await setup();
    const up = await signUp(t, "", PASSWORD);
    expect(up).toEqual({
      status: "error",
      userError: { error: "USERNAME_TOO_SHORT", minimumLength: 1 },
    });
  });

  test("stores the username in the username component", async () => {
    const t = await setup();
    const up = await signUp(t, "Alice", PASSWORD);
    const rows = await t.run(async (ctx) =>
      ctx.runQuery(components.authUsername.public.getUsername, {
        userId: (up as PasswordSuccess).tokens.userId,
      }),
    );
    expect(rows).toBe("Alice");
  });

  test("rejects a too-short password at sign-up without creating an account", async () => {
    const t = await setup();
    const up = await signUp(t, "alice", "short");
    expect(up).toEqual({
      status: "error",
      userError: { error: "PASSWORD_TOO_SHORT", minimumLength: 10 },
    });

    // No account was created, so a later sign-up with a valid password works.
    const retry = await signUp(t, "alice", PASSWORD);
    expect(retry).toEqual({
      status: "complete",
      tokens: {
        accessToken: expect.any(String),
        accessTokenExpiresAt: expect.any(Number),
        refreshToken: expect.any(String),
        refreshTokenExpiresAt: expect.any(Number),
        userId: expect.any(String),
      },
    });
  });
});

describe("changePassword", () => {
  const NEW_PASSWORD = "new horse battery staple";

  async function signedUpUser() {
    const t = await setup();
    const up = await signUp(t, "alice", PASSWORD);
    const userId = (up as PasswordSuccess).tokens.userId;
    return { t, userId, alice: asUser(t, userId) };
  }

  test("replaces the password when the current one is correct", async () => {
    const { t, alice } = await signedUpUser();
    const result = await alice.mutation(api.auth.changePassword, {
      currentPassword: PASSWORD,
      newPassword: NEW_PASSWORD,
    });
    expect(result).toEqual({ success: true });

    expect(await signIn(t, "alice", PASSWORD)).toEqual({
      status: "error",
      userError: { error: "INVALID_CREDENTIALS" },
    });
    expect(await signIn(t, "alice", NEW_PASSWORD)).toMatchObject({
      status: "complete",
    });
  });

  test("refuses a signed-out caller", async () => {
    const { t } = await signedUpUser();
    const result = await t.mutation(api.auth.changePassword, {
      currentPassword: PASSWORD,
      newPassword: NEW_PASSWORD,
    });
    expect(result).toEqual({
      success: false,
      userError: { error: "NOT_SIGNED_IN" },
    });
  });

  test("rejects a wrong current password and keeps the old one", async () => {
    const { t, alice } = await signedUpUser();
    const result = await alice.mutation(api.auth.changePassword, {
      currentPassword: "wrong horse battery staple",
      newPassword: NEW_PASSWORD,
    });
    expect(result).toEqual({
      success: false,
      userError: { error: "INVALID_CREDENTIALS" },
    });
    expect(await signIn(t, "alice", PASSWORD)).toMatchObject({
      status: "complete",
    });
  });

  test("reports a malformed current password as INVALID_CREDENTIALS", async () => {
    const { alice } = await signedUpUser();
    const result = await alice.mutation(api.auth.changePassword, {
      currentPassword: "short",
      newPassword: NEW_PASSWORD,
    });
    expect(result).toEqual({
      success: false,
      userError: { error: "INVALID_CREDENTIALS" },
    });
  });

  test("rejects a new password that is too common", async () => {
    const { t, alice } = await signedUpUser();
    const result = await alice.mutation(api.auth.changePassword, {
      currentPassword: PASSWORD,
      newPassword: "0000000000",
    });
    expect(result).toEqual({
      success: false,
      userError: { error: "PASSWORD_TOO_COMMON" },
    });
    expect(await signIn(t, "alice", PASSWORD)).toMatchObject({
      status: "complete",
    });
  });

  test("rejects a new password that is too short", async () => {
    const { alice } = await signedUpUser();
    const result = await alice.mutation(api.auth.changePassword, {
      currentPassword: PASSWORD,
      newPassword: "short",
    });
    expect(result).toEqual({
      success: false,
      userError: { error: "PASSWORD_TOO_SHORT", minimumLength: 10 },
    });
  });

  test("accepts a new password equal to the current one", async () => {
    const { t, alice } = await signedUpUser();
    const result = await alice.mutation(api.auth.changePassword, {
      currentPassword: PASSWORD,
      newPassword: PASSWORD,
    });
    expect(result).toEqual({ success: true });
    expect(await signIn(t, "alice", PASSWORD)).toMatchObject({
      status: "complete",
    });
  });

  test("rate limits the current-password checks per user", async () => {
    const { alice } = await signedUpUser();
    for (let i = 0; i < 5; i++) {
      await alice.mutation(api.auth.changePassword, {
        currentPassword: "wrong horse battery staple",
        newPassword: NEW_PASSWORD,
      });
    }
    const result = await alice.mutation(api.auth.changePassword, {
      currentPassword: PASSWORD,
      newPassword: NEW_PASSWORD,
    });
    expect(result).toEqual({
      success: false,
      userError: { error: "RATE_LIMITED", retryAfterMs: expect.any(Number) },
    });
  });
});

describe("TOTP second factor", () => {
  type T = Awaited<ReturnType<typeof setup>>;
  type SignInResult = Awaited<ReturnType<typeof signIn>>;
  type Incomplete = Extract<SignInResult, { status: "incomplete" }>;

  const PERIOD_MS = 30_000;
  // A moment in the middle of a time step, so that a few milliseconds of
  // test time never cross a step boundary.
  const START = 1_700_000_015_000;

  // The codes depend on the time. Only `Date` is faked, because convex-test
  // uses the real timers.
  const withClock =
    <R>(fn: () => Promise<R>) =>
    async () => {
      vi.useFakeTimers({ toFake: ["Date"] });
      vi.setSystemTime(START);
      try {
        return await fn();
      } finally {
        vi.useRealTimers();
      }
    };
  const advance = (ms: number) => vi.setSystemTime(Date.now() + ms);

  // The code the user's authenticator app shows for the secret right now.
  const codeFor = (secret: string) =>
    totpCode({ secret, algorithm: "SHA-1", digits: 6, period: 30 }, Date.now());

  /**
   * Sign Alice up and enroll her authenticator the way the app does it,
   * through the TOTP component. The confirmation code cannot sign in, so the
   * clock moves one step past it.
   */
  async function enrolledAlice(t: T) {
    const up = await signUp(t, "alice", PASSWORD);
    const userId = (up as PasswordSuccess).tokens.userId;
    const { secret, backupCodes } = await t.run(async (ctx) => {
      const { secret } = await ctx.runMutation(
        components.authTotp.enrollment.createTotp,
        { userId, issuerDisplayName: "Example", accountDisplayName: "alice" },
      );
      const confirmed = await ctx.runMutation(
        components.authTotp.enrollment.confirmTotp,
        { userId, code: await codeFor(secret) },
      );
      if (!confirmed.success) throw new Error("enrollment failed");
      return { secret, backupCodes: confirmed.backupCodes };
    });
    advance(PERIOD_MS);
    return { userId, secret, backupCodes };
  }

  /** Sign in and assert the sign-in is held for a code. */
  async function heldSignIn(t: T): Promise<Incomplete> {
    const result = await signIn(t, "alice", PASSWORD);
    expect(result).toEqual({
      status: "incomplete",
      attemptToken: expect.any(String),
      expiresAt: expect.any(Number),
      requirements: ["totp"],
    });
    return result as Incomplete;
  }

  /** The first step of finishing a held sign-in: verify a code for it. */
  const verify = (
    t: T,
    attemptToken: string,
    code: string,
    kind?: "totp" | "backup",
  ) => t.mutation(api.auth.verifyTotpForSignIn, { attemptToken, code, kind });

  /** The second step: ask the core to finish the sign-in. */
  const continueSignIn = (t: T, attemptToken: string) =>
    t.mutation(api.auth.continueSignIn, { attemptToken });

  const completeTokens = {
    accessToken: expect.any(String),
    accessTokenExpiresAt: expect.any(Number),
    refreshToken: expect.any(String),
    refreshTokenExpiresAt: expect.any(Number),
    userId: expect.any(String),
  };
  const expired = {
    status: "error",
    userError: { error: "SIGN_IN_EXPIRED" },
  };
  const stillOwed = (attemptToken: string) => ({
    status: "incomplete",
    attemptToken,
    expiresAt: expect.any(Number),
    requirements: ["totp"],
  });

  test(
    "a user without TOTP signs in as before",
    withClock(async () => {
      const t = await setup();
      await signUp(t, "alice", PASSWORD);
      expect(await signIn(t, "alice", PASSWORD)).toMatchObject({
        status: "complete",
      });
    }),
  );

  test(
    "an enrolled user's password alone holds the sign-in for a code",
    withClock(async () => {
      const t = await setup();
      await enrolledAlice(t);
      const held = await heldSignIn(t);
      expect(held.expiresAt).toBeGreaterThan(Date.now());

      // The wrong password is still the wrong password, held or not.
      expect(await signIn(t, "alice", "wrong horse battery staple")).toEqual({
        status: "error",
        userError: { error: "INVALID_CREDENTIALS" },
      });
    }),
  );

  test(
    "continuing before a code is verified reports the code still owed",
    withClock(async () => {
      const t = await setup();
      await enrolledAlice(t);
      const { attemptToken } = await heldSignIn(t);

      // Nothing was verified, so nothing is minted, and the same token keeps
      // continuing the sign-in.
      expect(await continueSignIn(t, attemptToken)).toEqual(
        stillOwed(attemptToken),
      );
      expect(await continueSignIn(t, attemptToken)).toEqual(
        stillOwed(attemptToken),
      );
    }),
  );

  test(
    "the right code lets the sign-in finish as the held user, once",
    withClock(async () => {
      const t = await setup();
      const { userId, secret } = await enrolledAlice(t);
      const { attemptToken } = await heldSignIn(t);

      // Verifying mints nothing by itself...
      expect(await verify(t, attemptToken, await codeFor(secret))).toEqual({
        success: true,
      });
      // ...continuing does, as the user the attempt names.
      const result = await continueSignIn(t, attemptToken);
      expect(result).toEqual({ status: "complete", tokens: completeTokens });
      expect(
        (result as Extract<typeof result, { status: "complete" }>).tokens
          .userId,
      ).toBe(userId);

      // The attempt is spent: neither step accepts the token again.
      advance(PERIOD_MS);
      expect(await verify(t, attemptToken, await codeFor(secret))).toEqual({
        success: false,
        userError: { error: "SIGN_IN_EXPIRED" },
      });
      expect(await continueSignIn(t, attemptToken)).toEqual(expired);
    }),
  );

  test(
    "a wrong code is refused and the attempt stays open for another try",
    withClock(async () => {
      const t = await setup();
      const { secret } = await enrolledAlice(t);
      const { attemptToken } = await heldSignIn(t);

      expect(await verify(t, attemptToken, "000000")).toEqual({
        success: false,
        userError: { error: "INVALID_CODE" },
      });
      expect(await continueSignIn(t, attemptToken)).toEqual(
        stillOwed(attemptToken),
      );
      expect(await verify(t, attemptToken, await codeFor(secret))).toEqual({
        success: true,
      });
      expect(await continueSignIn(t, attemptToken)).toMatchObject({
        status: "complete",
      });
    }),
  );

  test(
    "a backup code satisfies the sign-in and reports how many remain",
    withClock(async () => {
      const t = await setup();
      const { backupCodes } = await enrolledAlice(t);
      const { attemptToken } = await heldSignIn(t);

      expect(await verify(t, attemptToken, backupCodes[0], "backup")).toEqual({
        success: true,
        remainingBackupCodes: BACKUP_CODE_COUNT - 1,
      });
      expect(await continueSignIn(t, attemptToken)).toMatchObject({
        status: "complete",
      });
    }),
  );

  test(
    "a backup code typed as a TOTP code is refused",
    withClock(async () => {
      const t = await setup();
      const { backupCodes } = await enrolledAlice(t);
      const { attemptToken } = await heldSignIn(t);
      expect(await verify(t, attemptToken, backupCodes[0])).toEqual({
        success: false,
        userError: { error: "INVALID_CODE" },
      });
    }),
  );

  test(
    "an unknown attempt token is refused by both steps without checking the code",
    withClock(async () => {
      const t = await setup();
      const { secret } = await enrolledAlice(t);
      expect(await verify(t, "not-a-token", await codeFor(secret))).toEqual({
        success: false,
        userError: { error: "SIGN_IN_EXPIRED" },
      });
      expect(await continueSignIn(t, "not-a-token")).toEqual(expired);
    }),
  );

  test(
    "an expired attempt is refused by both steps",
    withClock(async () => {
      const t = await setup();
      const { secret } = await enrolledAlice(t);
      const { attemptToken, expiresAt } = await heldSignIn(t);
      vi.setSystemTime(expiresAt + 1);
      expect(await verify(t, attemptToken, await codeFor(secret))).toEqual({
        success: false,
        userError: { error: "SIGN_IN_EXPIRED" },
      });
      expect(await continueSignIn(t, attemptToken)).toEqual(expired);
    }),
  );

  test(
    "a fresh sign-in supersedes the earlier attempt, and its verified code with it",
    withClock(async () => {
      const t = await setup();
      const { secret } = await enrolledAlice(t);
      const first = await heldSignIn(t);
      // The code is verified for the first attempt...
      expect(
        await verify(t, first.attemptToken, await codeFor(secret)),
      ).toEqual({ success: true });
      // ...then a second sign-in replaces it. The first token is dead, and the
      // proof recorded for it does not carry over to the new attempt.
      const second = await heldSignIn(t);
      expect(second.attemptToken).not.toBe(first.attemptToken);
      expect(await continueSignIn(t, first.attemptToken)).toEqual(expired);
      expect(await continueSignIn(t, second.attemptToken)).toEqual(
        stillOwed(second.attemptToken),
      );

      advance(PERIOD_MS);
      expect(
        await verify(t, second.attemptToken, await codeFor(secret)),
      ).toEqual({ success: true });
      expect(await continueSignIn(t, second.attemptToken)).toMatchObject({
        status: "complete",
      });
    }),
  );

  test(
    "code guessing is rate limited per user",
    withClock(async () => {
      const t = await setup();
      await enrolledAlice(t);
      const { attemptToken } = await heldSignIn(t);
      for (let i = 0; i < 5; i++) {
        expect(await verify(t, attemptToken, "000000")).toEqual({
          success: false,
          userError: { error: "INVALID_CODE" },
        });
      }
      expect(await verify(t, attemptToken, "000000")).toEqual({
        success: false,
        userError: {
          error: "RATE_LIMITED",
          retryAfterMs: expect.any(Number),
        },
      });
    }),
  );

  test(
    "a user whose TOTP was turned off mid-flow owes no code",
    withClock(async () => {
      const t = await setup();
      const { userId } = await enrolledAlice(t);
      const { attemptToken } = await heldSignIn(t);
      await t.run((ctx) =>
        ctx.runMutation(components.authTotp.management.deleteUser, { userId }),
      );
      // There is no code to verify any more...
      expect(await verify(t, attemptToken, "000000")).toEqual({
        success: false,
        userError: { error: "NOT_ENROLLED" },
      });
      // ...and nothing stands between the held sign-in and a session.
      expect(await continueSignIn(t, attemptToken)).toMatchObject({
        status: "complete",
      });
    }),
  );
});
