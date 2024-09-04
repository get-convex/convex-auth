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
  signInViaGitHub,
  signInViaMagicLink,
  signInViaOTP,
} from "./test.helpers";

test("sign in with email signs out existing user with different email", async () => {
  setupEnv();
  const t = convexTest(schema);

  // 1. Sign up without email verification
  const { tokens } = await t.action(api.auth.signIn, {
    provider: "password",
    params: { email: "sarah@gmail.com", password: "44448888", flow: "signUp" },
  });

  const claims = decodeJwt(tokens!.token);
  const asMichal = t.withIdentity({ subject: claims.sub });

  const newTokens = await signInViaMagicLink(
    asMichal,
    "resend",
    "michal@gmail.com",
  );

  expect(newTokens).not.toBeNull();

  // 3. Check the first session got deleted
  await t.run(async (ctx) => {
    const sessions = await ctx.db.query("authSessions").collect();
    expect(sessions).toHaveLength(1);
  });
});

test("automatic linking for signin via email", async () => {
  setupEnv();
  const t = convexTest(schema);

  // 1. Sign in via verified OAuth
  await signInViaGitHub(t, "github", {
    email: "sarah@gmail.com",
    name: "Sarah",
    id: "someGitHubId",
  });

  // 2. Sign in via the same email
  const newTokens = await signInViaMagicLink(t, "resend", "sarah@gmail.com");
  expect(newTokens).not.toBeNull();

  // 3. Check that there is only one user, the linked one
  await t.run(async (ctx) => {
    const users = await ctx.db.query("users").collect();
    expect(users).toHaveLength(1);
    expect(users[0].emailVerificationTime).not.toBeUndefined();
  });
});

test("automatic linking for signin via verified OAuth", async () => {
  setupEnv();
  const t = convexTest(schema);

  // 1. Sign up via email
  await signInViaMagicLink(t, "resend", "sarah@gmail.com");

  // 2. Sign in via verified OAuth
  await signInViaGitHub(t, "github", {
    email: "sarah@gmail.com",
    name: "Sarah",
    id: "someGitHubId",
  });

  // 3. Check that there is only one user, the linked one
  await t.run(async (ctx) => {
    const users = await ctx.db.query("users").collect();
    expect(users).toHaveLength(1);
    expect(users[0].emailVerificationTime).not.toBeUndefined();
  });
});

test("automatic linking for password email verification", async () => {
  setupEnv();
  const t = convexTest(schema);

  // 1. Sign up first via verified OAuth
  await signInViaGitHub(t, "github", {
    email: "michal@gmail.com",
    name: "Michal",
    id: "someGitHubId",
  });

  // 2. Sign in via password and verify email
  const newTokens = await signInViaOTP(t, "password-code", {
    email: "michal@gmail.com",
    flow: "signUp",
    password: "verycomplex",
  });

  expect(newTokens).not.toBeNull();

  // 3. Check that there is only one user, the linked one
  await t.run(async (ctx) => {
    const users = await ctx.db.query("users").collect();
    expect(users).toHaveLength(1);
    expect(users[0].emailVerificationTime).not.toBeUndefined();
  });
});

test("no linking to untrusted accounts", async () => {
  setupEnv();
  const t = convexTest(schema);

  // 1. Sign up first via verified OAuth
  await signInViaGitHub(t, "github", {
    email: "sarah@gmail.com",
    name: "Sarah",
    id: "someGitHubId",
  });

  // 2. Sign up without email verification
  await t.action(api.auth.signIn, {
    provider: "password",
    params: { email: "sarah@gmail.com", password: "44448888", flow: "signUp" },
  });

  // 3. Sign up via email
  await signInViaMagicLink(t, "resend", "sarah@gmail.com");

  // 3. Check the users and accounts
  await t.run(async (ctx) => {
    const users = await ctx.db.query("users").collect();
    expect(users).toHaveLength(2);
    expect(users).toMatchObject([
      { email: "sarah@gmail.com", name: "Sarah" },
      { email: "sarah@gmail.com" },
    ]);
    const accounts = await ctx.db.query("authAccounts").collect();
    expect(accounts).toHaveLength(3);
    expect(accounts).toMatchObject([
      { provider: "github", userId: users[0]._id },
      { provider: "password", userId: users[1]._id },
      { provider: "resend", userId: users[0]._id },
    ]);
  });
});

function setupEnv() {
  process.env.SITE_URL = "http://localhost:5173";
  process.env.CONVEX_SITE_URL = CONVEX_SITE_URL;
  process.env.JWT_PRIVATE_KEY = JWT_PRIVATE_KEY;
  process.env.JWKS = JWKS;
  process.env.AUTH_RESEND_KEY = AUTH_RESEND_KEY;
  process.env.AUTH_GITHUB_ID = "githubClientId";
  process.env.AUTH_GITHUB_SECRET = "githubClientSecret";
  process.env.AUTH_LOG_LEVEL = "ERROR";
}
