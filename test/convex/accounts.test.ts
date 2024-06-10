import { convexTest } from "convex-test";
import { expect, test, vi } from "vitest";
import { api } from "./_generated/api";
import schema from "./schema";
import {
  AUTH_RESEND_KEY,
  CONVEX_SITE_URL,
  JWKS,
  JWT_PRIVATE_KEY,
  signInViaGitHub,
} from "./test.helpers";
import { decodeJwt } from "jose";

test("sign in with email signs out existing user with different email", async () => {
  setupEnv();
  const t = convexTest(schema);

  // 1. Sign up without email verification
  const { tokens } = await t.action(api.auth.signIn, {
    provider: "password",
    params: { email: "sarah@gmail.com", password: "44448888", flow: "signUp" },
  });

  // 2. Sign in via email, while already being signed in
  let code;
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input, init) => {
      if (
        typeof input === "string" &&
        input === "https://api.resend.com/emails"
      ) {
        code = init.body.match(/\?code=([^\s\\]+)/)?.[1];
        return new Response(null, { status: 200 });
      }
      throw new Error("Unexpected fetch");
    }),
  );

  const claims = decodeJwt(tokens.token);
  const asMichal = t.withIdentity({ subject: claims.sub });

  await asMichal.action(api.auth.signIn, {
    provider: "resend",
    params: { email: "michal@gmail.com" },
  });
  vi.unstubAllGlobals();

  const newTokens = await asMichal.action(api.auth.verifyCode, {
    params: { code },
  });

  expect(newTokens).not.toBeNull();

  // 3. Check the first session got deleted
  await t.run(async (ctx) => {
    const sessions = await ctx.db.query("sessions").collect();
    expect(sessions).toHaveLength(1);
  });
});

test("automatic linking for signin via email", async () => {
  setupEnv();
  const t = convexTest(schema);

  // 1. Sign up without email verification
  await t.action(api.auth.signIn, {
    provider: "password",
    params: { email: "sarah@gmail.com", password: "44448888", flow: "signUp" },
  });
  await t.run(async (ctx) => {
    const users = await ctx.db.query("users").collect();
    expect(users).toHaveLength(1);
    expect(users[0].emailVerificationTime).toBeUndefined();
  });

  // 2. Sign in via the same email
  let code;
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input, init) => {
      if (
        typeof input === "string" &&
        input === "https://api.resend.com/emails"
      ) {
        code = init.body.match(/\?code=([^\s\\]+)/)?.[1];
        return new Response(null, { status: 200 });
      }
      throw new Error("Unexpected fetch");
    }),
  );

  await t.action(api.auth.signIn, {
    provider: "resend",
    params: { email: "sarah@gmail.com" },
  });
  vi.unstubAllGlobals();

  const newTokens = await t.action(api.auth.verifyCode, {
    params: { code },
  });

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

  // 1. Sign up without email verification
  await t.action(api.auth.signIn, {
    provider: "password",
    params: { email: "sarah@gmail.com", password: "44448888", flow: "signUp" },
  });

  // 2. Sign in verified OAuth
  await signInViaGitHub(t, "github-verified", {
    email: "sarah@gmail.com",
    name: "Sara",
    id: "someGitHubId",
  });

  // 3. Check that there is only one user, the linked one
  await t.run(async (ctx) => {
    const users = await ctx.db.query("users").collect();
    expect(users).toHaveLength(1);
    expect(users[0].emailVerificationTime).not.toBeUndefined();
  });
});

function setupEnv() {
  process.env.SITE_URL = "http://localhost:5173";
  process.env.CONVEX_SITE_URL = CONVEX_SITE_URL;
  process.env.JWT_PRIVATE_KEY = JWT_PRIVATE_KEY;
  process.env.JWKS = JWKS;
  process.env.AUTH_RESEND_KEY = AUTH_RESEND_KEY;
  process.env.AUTH_GITHUB_VERIFIED_ID = "githubClientId";
  process.env.AUTH_GITHUB_VERIFIED_SECRET = "githubClientSecret";
}
