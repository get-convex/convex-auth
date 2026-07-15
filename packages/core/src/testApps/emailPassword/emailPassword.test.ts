import { convexTest } from "convex-test";
import { afterEach, describe, expect, test, vi } from "vitest";
import { exportJWK, exportPKCS8, generateKeyPair } from "jose";
import { api } from "./_generated/api";
import { registerCore } from "../../components/testing/core";
import { registerPasswordProvider } from "../../components/testing/password";
import { registerEmailValidation } from "../../components/testing/emailValidation";
import schema from "./schema";
import {
  getLastEmailedCode,
  getSendEmailCalls,
  resetSendEmailCalls,
} from "./resendSpy";

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

  const t = convexTest(schema, modules);
  registerCore(t);
  registerPasswordProvider(t);
  registerEmailValidation(t);
  return t;
}

afterEach(() => {
  vi.unstubAllEnvs();
  resetSendEmailCalls();
});

const vTokens = {
  accessToken: expect.any(String),
  accessTokenExpiresAt: expect.any(Number),
  refreshToken: expect.any(String),
  refreshTokenExpiresAt: expect.any(Number),
  userId: expect.any(String),
};

type T = Awaited<ReturnType<typeof setup>>;

const signUp = (t: T, email = EMAIL, password = PASSWORD) =>
  t.action(api.auth.signUpWithPassword, { email, password });
const confirm = (t: T, emailValidationSession: string, code: string) =>
  t.mutation(api.auth.confirmEmail, { emailValidationSession, code });
const signIn = (t: T, email = EMAIL, password = PASSWORD) =>
  t.action(api.auth.signInWithPassword, { email, password });

/** Sign up and return the session string plus the emailed code. */
async function signUpAndGetCode(t: T, email = EMAIL, password = PASSWORD) {
  const result = await signUp(t, email, password);
  if (!result.success) {
    throw new Error(`signUp failed: ${JSON.stringify(result.userError)}`);
  }
  return { session: result.emailValidationSession, code: getLastEmailedCode() };
}

describe("sign-up", () => {
  test("returns a session string, sends an email, and mints no tokens/account", async () => {
    const t = await setup();
    const result = await signUp(t);
    expect(result).toEqual({
      success: true,
      emailValidationSession: expect.any(String),
    });

    // An email was sent to the address with the code in the body.
    const calls = getSendEmailCalls();
    expect(calls).toHaveLength(1);
    expect(calls[0].to).toEqual([EMAIL]);
    expect(calls[0].from).toBe("My App <auth@example.com>");
    expect(calls[0].text).toContain(getLastEmailedCode());

    // A bare users row exists (no email yet). Map unset emails to `null` — a
    // `t.run` result is serialized as a Convex value, and a bare `undefined`
    // isn't one.
    const emails = await t.run(async (ctx) =>
      (await ctx.db.query("users").collect()).map((u) => u.email ?? null),
    );
    expect(emails).toEqual([null]);

    // No account exists yet, so signing in reports USER_NOT_FOUND.
    const inResult = await signIn(t);
    expect(inResult).toEqual({
      success: false,
      userError: { error: "USER_NOT_FOUND" },
    });
  });

  test("normalizes the email (trim + lowercase)", async () => {
    const t = await setup();
    const { session, code } = await signUpAndGetCode(t, "  Alice@Example.COM ");
    // The email is stored normalized...
    const confirmed = await confirm(t, session, code);
    expect(confirmed).toEqual({ success: true, tokens: vTokens });
    const emails = await t.run(async (ctx) =>
      (await ctx.db.query("users").collect()).map((u) => u.email),
    );
    expect(emails).toEqual([EMAIL]);
    // ...and a differently-cased sign-in resolves the same account.
    const inResult = await signIn(t, "ALICE@example.com");
    expect(inResult).toEqual({ success: true, tokens: vTokens });
  });

  test("rejects a too-short password without creating anything", async () => {
    const t = await setup();
    const result = await signUp(t, EMAIL, "short");
    expect(result).toEqual({
      success: false,
      userError: { error: "PASSWORD_TOO_SHORT", minimumLength: 10 },
    });
    expect(getSendEmailCalls()).toHaveLength(0);
    const users = await t.run(
      async (ctx) => (await ctx.db.query("users").collect()).length,
    );
    expect(users).toBe(0);
  });
});

describe("confirm", () => {
  test("mints tokens, sets the email, and creates exactly one account", async () => {
    const t = await setup();
    const { session, code } = await signUpAndGetCode(t);

    const confirmed = await confirm(t, session, code);
    expect(confirmed).toEqual({ success: true, tokens: vTokens });

    const emails = await t.run(async (ctx) =>
      (await ctx.db.query("users").collect()).map((u) => u.email),
    );
    expect(emails).toEqual([EMAIL]);

    // Sign-in now resolves the (single) account and returns the same user.
    const inResult = await signIn(t);
    expect(inResult).toEqual({ success: true, tokens: vTokens });
    if (confirmed.success && inResult.success) {
      expect(inResult.tokens.userId).toBe(confirmed.tokens.userId);
    }
  });

  test("rejects a wrong code with INVALID_CODE", async () => {
    const t = await setup();
    const { session, code } = await signUpAndGetCode(t);
    const wrong = code === "AAAAAAAA" ? "BBBBBBBB" : "AAAAAAAA";
    const result = await confirm(t, session, wrong);
    expect(result).toEqual({
      success: false,
      userError: { error: "INVALID_CODE" },
    });
  });

  test("is single-use: confirming twice fails the second time", async () => {
    const t = await setup();
    const { session, code } = await signUpAndGetCode(t);
    const first = await confirm(t, session, code);
    expect(first.success).toBe(true);
    const second = await confirm(t, session, code);
    expect(second).toEqual({
      success: false,
      userError: { error: "INVALID_CODE" },
    });
  });

  test("rate-limits repeated confirmation attempts on one session", async () => {
    const t = await setup();
    const { session } = await signUpAndGetCode(t);
    const wrong = "ZZZZZZZZ";

    // Capacity is 5 for the consume bucket; the 6th attempt is rejected by the
    // limiter with RATE_LIMITED.
    for (let i = 0; i < 5; i++) {
      await confirm(t, session, wrong);
    }
    const limited = await confirm(t, session, wrong);
    expect(limited.success).toBe(false);
    if (!limited.success) {
      expect(limited.userError.error).toBe("RATE_LIMITED");
    }
  });
});

describe("duplicate sign-ups for the same email", () => {
  test("first confirm wins; the second gets EMAIL_TAKEN", async () => {
    const t = await setup();
    const first = await signUpAndGetCode(t);
    const second = await signUpAndGetCode(t);

    // Both created their own pending users row.
    const before = await t.run(
      async (ctx) => (await ctx.db.query("users").collect()).length,
    );
    expect(before).toBe(2);

    const firstConfirm = await confirm(t, first.session, first.code);
    expect(firstConfirm.success).toBe(true);

    const secondConfirm = await confirm(t, second.session, second.code);
    expect(secondConfirm).toEqual({
      success: false,
      userError: { error: "EMAIL_TAKEN" },
    });
  });
});

describe("sign-in", () => {
  test("fails before confirmation and succeeds after", async () => {
    const t = await setup();
    const { session, code } = await signUpAndGetCode(t);

    const before = await signIn(t);
    expect(before).toEqual({
      success: false,
      userError: { error: "USER_NOT_FOUND" },
    });

    await confirm(t, session, code);

    const after = await signIn(t);
    expect(after).toEqual({ success: true, tokens: vTokens });
  });

  test("rejects a wrong password with INVALID_CREDENTIALS", async () => {
    const t = await setup();
    const { session, code } = await signUpAndGetCode(t);
    await confirm(t, session, code);
    const result = await signIn(t, EMAIL, "wrong horse battery staple");
    expect(result).toEqual({
      success: false,
      userError: { error: "INVALID_CREDENTIALS" },
    });
  });
});
