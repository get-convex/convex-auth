import { convexTest } from "convex-test";
import { decodeJwt } from "jose";
import { expect, test } from "vitest";
import { api } from "./_generated/api";
import schema from "./schema";
import {
  AUTH_RESEND_KEY,
  CONVEX_SITE_URL,
  JWKS,
  JWT_PRIVATE_KEY,
  mockResendOTP,
} from "./test.helpers";

test("sign up with password", async () => {
  setupEnv();
  const t = convexTest(schema);
  const { tokens } = await t.action(api.auth.signIn, {
    provider: "password",
    params: { email: "sarah@gmail.com", password: "44448888", flow: "signUp" },
  });

  expect(tokens).not.toBeNull();

  const { tokens: tokens2 } = await t.action(api.auth.signIn, {
    provider: "password",
    params: { email: "sarah@gmail.com", password: "44448888", flow: "signIn" },
  });

  expect(tokens2).not.toBeNull();

  await expect(async () => {
    await t.action(api.auth.signIn, {
      provider: "password",
      params: { email: "sarah@gmail.com", password: "wrong", flow: "signIn" },
    });
  }).rejects.toThrow("InvalidSecret");

  await t.run(async (ctx) => {
    const users = await ctx.db.query("users").collect();
    expect(users).toMatchObject([{ email: "sarah@gmail.com" }]);
    const accounts = await ctx.db.query("authAccounts").collect();
    expect(accounts).toMatchObject([
      { provider: "password", providerAccountId: "sarah@gmail.com" },
    ]);
    const sessions = await ctx.db.query("authSessions").collect();
    expect(sessions).toHaveLength(2);
  });

  // Sign out from each session

  const claims = decodeJwt(tokens!.token);
  await t.withIdentity({ subject: claims.sub }).action(api.auth.signOut);

  await t.run(async (ctx) => {
    const sessions = await ctx.db.query("authSessions").collect();
    expect(sessions).toHaveLength(1);
  });

  const claims2 = decodeJwt(tokens2!.token);
  await t.withIdentity({ subject: claims2.sub }).action(api.auth.signOut);

  await t.run(async (ctx) => {
    const sessions = await ctx.db.query("authSessions").collect();
    expect(sessions).toHaveLength(0);
  });
});

test("sign up with password and verify email", async () => {
  setupEnv();
  const t = convexTest(schema);

  const {
    code,
    result: { tokens },
  } = await mockResendOTP(
    async () =>
      await t.action(api.auth.signIn, {
        provider: "password-code",
        params: {
          email: "sarah@gmail.com",
          password: "44448888",
          flow: "signUp",
        },
      }),
  );

  // Not signed in because we sent an email
  expect(tokens).toBeNull();

  // Finish email verification with code
  const { tokens: validTokens } = await t.action(api.auth.signIn, {
    provider: "password-code",
    params: {
      email: "sarah@gmail.com",
      flow: "email-verification",
      code,
    },
  });

  expect(validTokens).not.toBeNull();

  // Now we can sign-in just with a password
  const { tokens: validTokens2 } = await t.action(api.auth.signIn, {
    provider: "password-code",
    params: {
      email: "sarah@gmail.com",
      flow: "signIn",
      password: "44448888",
    },
  });

  expect(validTokens2).not.toBeNull();
});

function setupEnv() {
  process.env.SITE_URL = "http://localhost:5173";
  process.env.CONVEX_SITE_URL = CONVEX_SITE_URL;
  process.env.JWT_PRIVATE_KEY = JWT_PRIVATE_KEY;
  process.env.JWKS = JWKS;
  process.env.AUTH_RESEND_KEY = AUTH_RESEND_KEY;
  process.env.AUTH_LOG_LEVEL = "ERROR";
}
