import { convexTest } from "convex-test";
import { afterEach, describe, expect, test, vi } from "vitest";
import { exportJWK, exportPKCS8, generateKeyPair } from "jose";
import type { AnyDataModel, GenericMutationCtx } from "convex/server";
import { api, components } from "./_generated/api";
import { registerCore } from "@convex-dev/auth/providers/testing/core";
import { registerPasswordProvider } from "@convex-dev/auth/providers/testing/password";
import { registerEmail } from "@convex-dev/auth/providers/testing/email";
import { registerResendStub } from "@convex-dev/auth/providers/testing/resend";
import { sha256Hex } from "@convex-dev/auth/lib/crypto";
import schema from "./schema";

const modules = import.meta.glob("./**/*.ts");

const PASSWORD = "correct horse battery staple"; // 28 chars, valid
const EMAIL = "alice@example.com";

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
  // The recipe reads the Resend API key from the environment; the stub
  // records the value without using it.
  vi.stubEnv("RESEND_API_KEY", "re_test_key");

  const t = convexTest(schema, modules);
  registerCore(t);
  registerPasswordProvider(t);
  registerEmail(t);
  registerResendStub(t);
  return t;
}

afterEach(() => {
  vi.unstubAllEnvs();
});

type T = Awaited<ReturnType<typeof setup>>;

/**
 * Run a function against a registered component's own database. convex-test
 * exposes `runInComponent` at runtime but does not declare it yet, hence the
 * cast. We use it to seed component state that only the `start` mutations write
 * in production — that mutation needs `ctx.meta`, which convex-test does not
 * supply.
 */
function runInComponent<Output>(
  t: T,
  componentPath: string,
  handler: (ctx: GenericMutationCtx<AnyDataModel>) => Promise<Output>,
): Promise<Output> {
  const testApi = t as unknown as {
    runInComponent(
      componentPath: string,
      handler: (ctx: GenericMutationCtx<AnyDataModel>) => Promise<Output>,
    ): Promise<Output>;
  };
  return testApi.runInComponent(componentPath, handler);
}

/**
 * Put the system in the state a validated sign-up leaves behind: an app
 * user, its account in the core, a verified primary email, and a password.
 */
async function seedSignedUpUser(
  t: T,
  { email = EMAIL, password = PASSWORD } = {},
) {
  const userId = await t.run(
    async (ctx) => await ctx.db.insert("users", { email }),
  );
  await runInComponent(t, "auth", async (ctx) => {
    await ctx.db.insert("accounts", {
      provider: "emailPassword",
      providerAccountId: userId,
      userId,
    });
  });
  await runInComponent(t, "authEmail", async (ctx) => {
    await ctx.db.insert("verifiedEmails", {
      email,
      normalizedEmail: normalizeEmail(email),
      userId,
      isPrimary: true,
    });
  });
  await t.run(async (ctx) => {
    const result = await ctx.runMutation(
      components.authPasswordProvider.public.setPassword,
      { userId, password },
    );
    if (!result.success) {
      throw new Error("Could not seed the password");
    }
  });
  return userId;
}

/**
 * Mirror of the component's `normalizeEmail`, for rows the tests seed
 * directly. The tests do not import component internals.
 */
function normalizeEmail(email: string): string {
  return email.toLowerCase().normalize("NFC");
}

/** The purpose string of the recipe's recovery challenge. */
const RECOVERY = {
  kind: "custom",
  purpose: "convexAuth/emailPassword/recovery",
} as const;

/** Seed a pending challenge, hashing the code + secret like production. */
async function seedChallenge(
  t: T,
  args: {
    email: string;
    userId: string | null;
    purpose:
      | { kind: "addEmail" }
      | { kind: "setPrimaryEmail" }
      | { kind: "custom"; purpose: string };
    code: string;
    secret: string;
  },
) {
  await runInComponent(t, "authEmail", async (ctx) => {
    await ctx.db.insert("challenges", {
      email: args.email,
      normalizedEmail: normalizeEmail(args.email),
      userId: args.userId,
      purpose: args.purpose,
      codeHash: await sha256Hex(args.code),
      secretHash: await sha256Hex(args.secret),
      expiresAt: Date.now() + 60_000,
    });
  });
}

/** The emails the Resend stub recorded, oldest first. */
function sentEmails(t: T) {
  return runInComponent(t, "resend", async (ctx) => {
    const rows = await ctx.db.query("emails").collect();
    return rows.map((row) => ({
      to: row.to as string[],
      subject: row.subject as string,
      text: row.text as string,
    }));
  });
}

const SESSION_TOKENS = {
  accessToken: expect.any(String),
  accessTokenExpiresAt: expect.any(Number),
  refreshToken: expect.any(String),
  refreshTokenExpiresAt: expect.any(Number),
  userId: expect.any(String),
};

describe("signUp", () => {
  test("rejects a malformed email before creating anything", async () => {
    const t = await setup();
    const result = await t.mutation(api.auth.signUp, {
      email: "not-an-email",
      password: PASSWORD,
    });
    expect(result).toEqual({
      success: false,
      userError: { error: "INVALID_EMAIL" },
    });
    const users = await t.run(
      async (ctx) => (await ctx.db.query("users").collect()).length,
    );
    expect(users).toBe(0);
  });

  test("rejects a too-short password before creating anything", async () => {
    const t = await setup();
    const result = await t.mutation(api.auth.signUp, {
      email: EMAIL,
      password: "short",
    });
    expect(result).toEqual({
      success: false,
      userError: { error: "PASSWORD_TOO_SHORT", minimumLength: 10 },
    });
  });

  test("rejects an email that is already verified with EMAIL_TAKEN", async () => {
    const t = await setup();
    await seedSignedUpUser(t);
    const result = await t.mutation(api.auth.signUp, {
      email: EMAIL,
      password: PASSWORD,
    });
    expect(result).toEqual({
      success: false,
      userError: { error: "EMAIL_TAKEN" },
    });
  });

  // TODO: enable when convex-test supports ctx.meta (the happy path reaches
  // challenge.rateLimit.checkStart, which reads the client IP).
  test.skip("creates the user without a session and sends the link", () => {});
  test.skip("returns RATE_LIMITED without creating the user", () => {});
});

describe("completeSignUp", () => {
  test("validates the email and signs the user in", async () => {
    const t = await setup();
    // The state signUp leaves behind: user + account + password, and a
    // pending challenge (no verified email yet).
    const userId = await t.run(
      async (ctx) => await ctx.db.insert("users", { email: EMAIL }),
    );
    await runInComponent(t, "auth", async (ctx) => {
      await ctx.db.insert("accounts", {
        provider: "emailPassword",
        providerAccountId: userId,
        userId,
      });
    });
    await t.run(async (ctx) => {
      await ctx.runMutation(
        components.authPasswordProvider.public.setPassword,
        {
          userId,
          password: PASSWORD,
        },
      );
    });
    await seedChallenge(t, {
      email: EMAIL,
      userId,
      purpose: { kind: "addEmail" },
      code: "code1",
      secret: "secret1",
    });

    const result = await t.mutation(api.auth.completeSignUp, {
      code: "code1",
      secret: "secret1",
    });
    expect(result).toEqual({ success: true, tokens: SESSION_TOKENS });

    // The email is now verified, so sign-in works.
    const signIn = await t.mutation(api.auth.signIn, {
      email: EMAIL,
      password: PASSWORD,
    });
    expect(signIn).toEqual({ success: true, tokens: SESSION_TOKENS });
  });

  test("rejects a bad code with INVALID_LINK", async () => {
    const t = await setup();
    const result = await t.mutation(api.auth.completeSignUp, {
      code: "unknown",
      secret: "whatever",
    });
    expect(result).toEqual({
      success: false,
      userError: { error: "INVALID_LINK" },
    });
  });

  test("the first completed validation wins a duplicate sign-up race", async () => {
    const t = await setup();
    const mkUser = async (email: string) => {
      const userId = await t.run(
        async (ctx) => await ctx.db.insert("users", { email }),
      );
      await runInComponent(t, "auth", async (ctx) => {
        await ctx.db.insert("accounts", {
          provider: "emailPassword",
          providerAccountId: userId,
          userId,
        });
      });
      return userId;
    };
    const user1 = await mkUser(EMAIL);
    const user2 = await mkUser(EMAIL);
    await seedChallenge(t, {
      email: EMAIL,
      userId: user1,
      purpose: { kind: "addEmail" },
      code: "code1",
      secret: "secret1",
    });
    await seedChallenge(t, {
      email: EMAIL,
      userId: user2,
      purpose: { kind: "addEmail" },
      code: "code2",
      secret: "secret2",
    });

    const first = await t.mutation(api.auth.completeSignUp, {
      code: "code2",
      secret: "secret2",
    });
    expect(first).toEqual({ success: true, tokens: SESSION_TOKENS });

    // The other sign-up's link stays pending, but the address is taken now.
    const second = await t.mutation(api.auth.completeSignUp, {
      code: "code1",
      secret: "secret1",
    });
    expect(second).toEqual({
      success: false,
      userError: { error: "EMAIL_TAKEN" },
    });
  });
});

describe("signIn", () => {
  test("signs in with the correct password against a verified email", async () => {
    const t = await setup();
    const userId = await seedSignedUpUser(t);
    const result = await t.mutation(api.auth.signIn, {
      email: EMAIL,
      password: PASSWORD,
    });
    expect(result).toEqual({ success: true, tokens: SESSION_TOKENS });
    expect((result as { tokens: { userId: string } }).tokens.userId).toBe(
      userId,
    );
  });

  test("ignores the case of the email", async () => {
    const t = await setup();
    await seedSignedUpUser(t);
    const result = await t.mutation(api.auth.signIn, {
      email: "ALICE@Example.COM",
      password: PASSWORD,
    });
    expect(result).toEqual({ success: true, tokens: SESSION_TOKENS });
  });

  test("rejects a wrong password with INVALID_CREDENTIALS", async () => {
    const t = await setup();
    await seedSignedUpUser(t);
    const result = await t.mutation(api.auth.signIn, {
      email: EMAIL,
      password: "wrong horse battery staple",
    });
    expect(result).toEqual({
      success: false,
      userError: { error: "INVALID_CREDENTIALS" },
    });
  });

  test("rejects an unknown email with USER_NOT_FOUND", async () => {
    const t = await setup();
    const result = await t.mutation(api.auth.signIn, {
      email: "nobody@example.com",
      password: PASSWORD,
    });
    expect(result).toEqual({
      success: false,
      userError: { error: "USER_NOT_FOUND" },
    });
  });
});

describe("changePassword", () => {
  test("requires a session", async () => {
    const t = await setup();
    const result = await t.mutation(api.auth.changePassword, {
      currentPassword: PASSWORD,
      newPassword: "brand new horse staple",
    });
    expect(result).toEqual({
      success: false,
      userError: { error: "NOT_LOGGED_IN" },
    });
  });

  test("requires the current password", async () => {
    const t = await setup();
    const userId = await seedSignedUpUser(t);
    const result = await t
      .withIdentity({ subject: userId })
      .mutation(api.auth.changePassword, {
        currentPassword: "wrong horse battery staple",
        newPassword: "brand new horse staple",
      });
    expect(result).toEqual({
      success: false,
      userError: { error: "INVALID_CREDENTIALS" },
    });
  });

  test("changes the password and notifies the primary email", async () => {
    const t = await setup();
    const userId = await seedSignedUpUser(t);
    const result = await t
      .withIdentity({ subject: userId })
      .mutation(api.auth.changePassword, {
        currentPassword: PASSWORD,
        newPassword: "brand new horse staple",
      });
    expect(result).toEqual({ success: true });

    // The old password no longer works; the new one does.
    const oldSignIn = await t.mutation(api.auth.signIn, {
      email: EMAIL,
      password: PASSWORD,
    });
    expect(oldSignIn).toMatchObject({ success: false });
    const newSignIn = await t.mutation(api.auth.signIn, {
      email: EMAIL,
      password: "brand new horse staple",
    });
    expect(newSignIn).toEqual({ success: true, tokens: SESSION_TOKENS });

    // A security notification went to the primary address.
    const sent = await sentEmails(t);
    expect(sent).toHaveLength(1);
    expect(sent[0].to).toEqual([EMAIL]);
    expect(sent[0].subject).toMatch(/password/i);
  });
});

describe("startChangeEmail", () => {
  test("requires a session", async () => {
    const t = await setup();
    const result = await t.mutation(api.auth.startChangeEmail, {
      newEmail: "new@example.com",
      currentPassword: PASSWORD,
    });
    expect(result).toEqual({
      success: false,
      userError: { error: "NOT_LOGGED_IN" },
    });
  });

  // TODO: enable when convex-test supports ctx.meta (the happy path reaches
  // challenge.setPrimaryEmail.start, which reads the client IP).
  test.skip("sends a confirmation link to the new address", () => {});
});

describe("completeChangeEmail", () => {
  test("replaces the primary email and notifies the old address", async () => {
    const t = await setup();
    const userId = await seedSignedUpUser(t);
    await seedChallenge(t, {
      email: "new@example.com",
      userId,
      purpose: { kind: "setPrimaryEmail" },
      code: "code1",
      secret: "secret1",
    });

    const result = await t.mutation(api.auth.completeChangeEmail, {
      code: "code1",
      secret: "secret1",
    });
    expect(result).toEqual({ success: true });

    // Sign-in works with the new address, and no longer with the old one.
    const newSignIn = await t.mutation(api.auth.signIn, {
      email: "new@example.com",
      password: PASSWORD,
    });
    expect(newSignIn).toEqual({ success: true, tokens: SESSION_TOKENS });
    const oldSignIn = await t.mutation(api.auth.signIn, {
      email: EMAIL,
      password: PASSWORD,
    });
    expect(oldSignIn).toEqual({
      success: false,
      userError: { error: "USER_NOT_FOUND" },
    });

    // The notification went to the OLD address: its owner must learn about
    // the change even though the address left the account.
    const sent = await sentEmails(t);
    expect(sent).toHaveLength(1);
    expect(sent[0].to).toEqual([EMAIL]);
    expect(sent[0].subject).toMatch(/email address/i);
  });

  test("rejects a bad code with INVALID_LINK", async () => {
    const t = await setup();
    const result = await t.mutation(api.auth.completeChangeEmail, {
      code: "unknown",
      secret: "whatever",
    });
    expect(result).toEqual({
      success: false,
      userError: { error: "INVALID_LINK" },
    });
  });
});

describe("startRecovery", () => {
  // TODO: enable when convex-test supports ctx.meta (every path reaches
  // challenge.rateLimit.checkStart, which reads the client IP).
  test.skip("sends a reset link to a verified email", () => {});
  test.skip("surfaces EMAIL_NOT_FOUND for an unknown email", () => {});
});

describe("completeRecovery", () => {
  test("sets the new password, signs in, and notifies", async () => {
    const t = await setup();
    await seedSignedUpUser(t);
    await seedChallenge(t, {
      email: EMAIL,
      userId: null,
      purpose: RECOVERY,
      code: "code1",
      secret: "secret1",
    });

    const result = await t.mutation(api.auth.completeRecovery, {
      code: "code1",
      secret: "secret1",
      newPassword: "brand new horse staple",
    });
    expect(result).toEqual({ success: true, tokens: SESSION_TOKENS });

    const newSignIn = await t.mutation(api.auth.signIn, {
      email: EMAIL,
      password: "brand new horse staple",
    });
    expect(newSignIn).toEqual({ success: true, tokens: SESSION_TOKENS });

    const sent = await sentEmails(t);
    expect(sent).toHaveLength(1);
    expect(sent[0].to).toEqual([EMAIL]);
    expect(sent[0].subject).toMatch(/password/i);
  });

  test("rejects a malformed new password without burning the link", async () => {
    const t = await setup();
    await seedSignedUpUser(t);
    await seedChallenge(t, {
      email: EMAIL,
      userId: null,
      purpose: RECOVERY,
      code: "code1",
      secret: "secret1",
    });

    const bad = await t.mutation(api.auth.completeRecovery, {
      code: "code1",
      secret: "secret1",
      newPassword: "short",
    });
    expect(bad).toEqual({
      success: false,
      userError: { error: "PASSWORD_TOO_SHORT", minimumLength: 10 },
    });

    // The link still works with a valid password.
    const good = await t.mutation(api.auth.completeRecovery, {
      code: "code1",
      secret: "secret1",
      newPassword: "brand new horse staple",
    });
    expect(good).toEqual({ success: true, tokens: SESSION_TOKENS });
  });

  test("rejects a link whose address left the account", async () => {
    const t = await setup();
    const userId = await seedSignedUpUser(t);
    await seedChallenge(t, {
      email: EMAIL,
      userId: null,
      purpose: RECOVERY,
      code: "code1",
      secret: "secret1",
    });
    // The address is no longer verified for any account.
    await runInComponent(t, "authEmail", async (ctx) => {
      for (const row of await ctx.db.query("verifiedEmails").collect()) {
        await ctx.db.delete("verifiedEmails", row._id);
      }
    });

    const result = await t.mutation(api.auth.completeRecovery, {
      code: "code1",
      secret: "secret1",
      newPassword: "brand new horse staple",
    });
    expect(result).toEqual({
      success: false,
      userError: { error: "INVALID_LINK" },
    });
    // Nothing was reset: with the address back, the old password still works.
    await runInComponent(t, "authEmail", async (ctx) => {
      await ctx.db.insert("verifiedEmails", {
        email: EMAIL,
        normalizedEmail: normalizeEmail(EMAIL),
        userId,
        isPrimary: true,
      });
    });
    expect(
      await t.mutation(api.auth.signIn, { email: EMAIL, password: PASSWORD }),
    ).toEqual({ success: true, tokens: SESSION_TOKENS });
  });

  test("rejects a bad code with INVALID_LINK", async () => {
    const t = await setup();
    const result = await t.mutation(api.auth.completeRecovery, {
      code: "unknown",
      secret: "whatever",
      newPassword: "brand new horse staple",
    });
    expect(result).toEqual({
      success: false,
      userError: { error: "INVALID_LINK" },
    });
  });
});

describe("getChallengeStatus", () => {
  test("reports pending for a live link and invalid otherwise", async () => {
    const t = await setup();
    await seedSignedUpUser(t);
    await seedChallenge(t, {
      email: EMAIL,
      userId: null,
      purpose: RECOVERY,
      code: "code1",
      secret: "secret1",
    });

    expect(
      await t.query(api.auth.getChallengeStatus, {
        code: "code1",
        secret: "secret1",
        flow: "recovery",
      }),
    ).toEqual({ status: "pending", email: EMAIL });
    // A link from another flow reports invalid.
    expect(
      await t.query(api.auth.getChallengeStatus, {
        code: "code1",
        secret: "secret1",
        flow: "signUp",
      }),
    ).toEqual({ status: "invalid" });
    expect(
      await t.query(api.auth.getChallengeStatus, {
        code: "code1",
        secret: "wrong",
        flow: "recovery",
      }),
    ).toEqual({ status: "invalid" });
  });
});
